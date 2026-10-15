import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
import {resolve} from 'node:path';
import {validateDataset,HistoricalMarket,type HistoryDataset} from '../src/core/backtest-data.js';
import {runBacktest,BacktestRequestSchema} from '../src/core/backtest.js';
import {SettingsSchema,twDay,type Analysis,type Decision} from '../src/core/models.js';
import {validateAnalysis} from '../src/core/strategy.js';
import {trackEntry} from '../src/core/smart.js';
import {entryQualityIssues,entryRiskIssues,roundTripEstimate} from '../src/core/costs.js';
import {EntryDiagnosticTracker} from '../src/core/entry-diagnostics.js';
import {rig,now,quote,account,snapshot,instrument} from './helpers.js';
const f={sufficient:true,sessions:100,asof:'2026-10-07',ma5:30,ma20:29,ma60:28,atr14:1,support20:27,resistance20:35,rsi14:60,volume_ratio20:1.5};
const trend:Decision={symbol:'9001',action:'BUY',shares:30,limit_price:'31',entry_when:'IMMEDIATE',trigger_price:'0',
  entry_strategy:'TREND_CONTINUATION',tracking_timeout_minutes:5,confirmation_ticks:2,confirmation_seconds:30,
  smart:{stop_price:'28',take_profit:'35',trailing_activate:null,trailing_fraction:null},reason:'isolated'};
function data():HistoryDataset{
  const d=JSON.parse(inflateSync(Buffer.from(readFileSync(resolve('tests/fixtures/observed-market-v022.deflate.b64'),'utf8').trim(),'base64')).toString()) as HistoryDataset;
  d.points=d.points.filter(p=>p.at.startsWith('2026-09-15'));d.observations=d.observations!.filter(o=>o.at.startsWith('2026-09-15'));return validateDataset(d);
}
test('trend confirmation cannot count a falling trade as persistent positive price momentum',()=>{
  const q=(p:string,n:number)=>({...quote(new Date(now.getTime()+n*1000)),last:p});
  let t=trackEntry(undefined,trend,'p',q('30',0),now.toISOString());
  t=trackEntry(t,trend,'p',q('29.9',30),now.toISOString());assert.equal(t.state,'WAITING');assert.equal(t.confirmations,0);
  t=trackEntry(t,trend,'p',q('30',60),now.toISOString());assert.equal(t.state,'CONFIRMING');
  t=trackEntry(t,trend,'p',q('30.1',90),now.toISOString());assert.equal(t.state,'READY');
});
test('cost and gap checks remain enabled even when the independent ordinary RR/trade-risk threshold is disabled',()=>{
  const s=SettingsSchema.parse({min_entry_reward_risk:'0',max_trade_risk_fraction:'0',min_net_reward_twd:'80',
    gap_stress_fraction:'0.1',max_gap_risk_fraction:'0.01'});
  assert.match(entryQualityIssues(1,'30',trend.smart!,s).join(),/費|成本/);
  assert.match(entryRiskIssues(999,'30',trend.smart!,account(),s).join(),/跳空/);
});
test('sparse observations reject future daily indicators and metadata and cannot pretend to be a full minute dataset',async()=>{
  const point={symbol:'9001',at:now.toISOString(),open:'30',high:'30',low:'30',close:'30',volume_shares:0,bid:'29.95',ask:'30.05',bid_shares:50,ask_shares:50};
  const o={at:now.toISOString(),features:{9001:f},metadata:{9001:instrument()},universe:snapshot().universe.slice(0,1)};
  const d:HistoryDataset={points:[point],observations:[o],source:'isolated observation',synthetic:true,coverage:'SPARSE_OBSERVATIONS',frequency:'MINUTE',names:{},limitations:[]};
  assert.throws(()=>validateDataset({...d,coverage:undefined}),/稀疏/);
  assert.throws(()=>validateDataset({...d,observations:[{...o,features:{9001:{...f,asof:'2026-10-08'}}}]}),/未來/);
  assert.throws(()=>validateDataset({...d,observations:[{...o,metadata:{9001:{...instrument(),verified_at:new Date(now.getTime()+1000).toISOString()}}}]}),/未來/);
  const market=new HistoricalMarket(validateDataset(d),'.01');
  assert.equal(market.features('9001',new Date(now.getTime()-1000)),undefined);
  assert.equal(market.features('9001',now)!.ma20,29);
  market.features('9001',now)!.ma20=999;assert.equal(market.features('9001',now)!.ma20,29);
});
test('sparse replay remains PARTIAL with explicit coverage limits while full metrics and trigger/refusal records are preserved',async()=>{
  const r=await runBacktest({start:'2026-09-15',end:'2026-09-15',strategy:'rules',source:'csv',optimization:'integrated',
    capital_profile:'active',entry_cadence:'market',strategy_schedule:'fixed',strategy_times:['09:15','11:45']},
    data(),SettingsSchema.parse({}),undefined,new AbortController().signal);
  assert.equal(r.status,'PARTIAL');assert.match(r.limitations.join(),/稀疏快照/);
  assert.ok(r.metrics.exit_metrics);assert.ok(r.entry_diagnostics?.capital_idle);assert.ok(r.fill_risk_checks);
  assert.ok(r.workflow?.some(e=>e.stage==='STATE'));
});
test('invalid candidates get at most one complete same-snapshot repair and every retry consumes the shared call limit',async()=>{
  for(const max of [1,2]){
    const stamps:string[]=[];
    const r=await runBacktest({start:'2026-09-15',end:'2026-09-15',strategy:'codex',source:'csv',max_codex_calls:max,
      capital_profile:'active',strategy_schedule:'fixed',strategy_times:['09:15']},data(),SettingsSchema.parse({codex_enabled:true}),
      async s=>{stamps.push(s.asof);return {snapshot_id:s.snapshot_id,expires_at:new Date(Date.parse(s.asof)+3600000).toISOString(),
        stance:'HOLD_ONLY',candidates:stamps.length===1?['9999']:s.universe.slice(0,5).map(c=>c.symbol),decisions:[],screening:null,summary:'isolated repair'};},
      new AbortController().signal);
    assert.equal(stamps.length,max);assert.equal(r.metrics.codex_calls,max);assert.equal(r.orders.length,0);
    if(max===1){assert.equal(r.status,'FAILED');assert.equal(r.metrics.decision_failures,1);}
    else {assert.equal(stamps[0],stamps[1]);assert.ok(r.workflow!.some(e=>e.stage==='REPAIR'));assert.equal(r.metrics.decision_failures,0);}
  }
});
test('all ablation variants share cash/fees/slippage/data while requesting exactly one optimization component',async()=>{
  const modes=['baseline','entries','exits','allocation','integrated'] as const;
  for(const optimization of modes){
    const r=await runBacktest({start:'2026-09-15',end:'2026-09-15',source:'csv',strategy:'rules',optimization,
      initial_cash:'100000',capital_profile:'active',cost_profile:'conservative',slippage_fraction:'0.001',
      entry_cadence:'market',strategy_schedule:'fixed',strategy_times:['09:15']},data(),SettingsSchema.parse({}),undefined,new AbortController().signal);
    assert.equal(r.metrics.initial_cash,'100000');assert.equal(r.settings.minimum_fee,'20');assert.equal(r.settings.simulation_slippage_fraction,'0.001');
    assert.equal(r.settings.adaptive_entries,optimization==='entries'||optimization==='integrated');
    assert.equal(r.settings.adaptive_exits,optimization==='exits'||optimization==='integrated');
    assert.equal(r.settings.dynamic_allocation,optimization==='allocation'||optimization==='integrated');
  }
  assert.ok(BacktestRequestSchema.parse({start:'2026-09-15',end:'2026-09-15',strategy:'rules',compare_optimizations:true}));
});
test('actual partial fill risk uses cumulative filled quantity, actual fees and actual average price',async()=>{
  const r=await rig();try{
    r.engine.setSettings({...r.s,max_trade_risk_fraction:'0.001'});await r.engine.tick(now);
    await r.engine.tick(new Date(now.getTime()+1000));const check=r.broker.riskChecks()[0]!;
    assert.equal(check.filled_shares,17);assert.equal(check.buy_fee,r.broker.fills()[0]!.fee);
    assert.equal(check.estimated_stop_loss,roundTripEstimate(17,check.average_fill_price,null,r.engine.settings,'29').estimated_stop_loss);
    assert.deepEqual(check.issues,[]);
  }finally{await r.engine.close();r.store.close();}
});
test('a gap-through entry fill is audited and stops further buys while preserving sellability restrictions',async()=>{
  const r=await rig();try{
    r.engine.setSettings({...r.s,max_trade_risk_fraction:'0.001'});await r.engine.tick(now);
    r.market.marketPrice='28';await r.engine.tick(new Date(now.getTime()+1000));
    assert.ok(r.broker.fills().length);assert.match(r.broker.riskChecks()[0]!.issues.join(),/停損/);
    assert.ok(r.store.get('postfill_block_2026-10-08'));assert.equal(r.engine.account!.positions[0]!.sellable,0);
  }finally{await r.engine.close();r.store.close();}
});
test('a completed sell clears protection and rebound tracking after confirmed inventory refresh',async()=>{
  const r=await rig();try{
    await r.engine.tick(now);await r.engine.tick(new Date(now.getTime()+1000));await r.engine.tick(new Date(now.getTime()+2000));
    r.store.saveEntryTrack(trackEntry(undefined,{...trend,entry_when:'REBOUND',trigger_price:'30',rebound_fraction:'0.01'},r.engine.plan!.id,quote(),now.toISOString()));
    r.market.marketPrice='28';const next=new Date(r.calendar.next(twDay(now))+'T10:00:00+08:00');await r.engine.tick(next);await r.engine.tick(new Date(next.getTime()+1000));
    assert.equal(r.engine.account!.positions[0]!.shares,13);assert.equal(r.store.protections().length,1);
    await r.engine.tick(new Date(next.getTime()+2000));
    assert.equal(r.engine.account!.positions.length,0);assert.equal(r.store.protections().length,0);assert.equal(r.store.entryTracks().length,0);
  }finally{await r.engine.close();r.store.close();}
});
test('entry plans cannot cross trading days; old persisted plans retain protection without new entries',async()=>{
  const s=snapshot(),a:Analysis={snapshot_id:s.snapshot_id,expires_at:new Date(now.getTime()+23*3600000).toISOString(),
    stance:'HOLD_ONLY',candidates:[],decisions:[],summary:'old plan'};
  assert.throws(()=>validateAnalysis(a,s,now,SettingsSchema.parse({plan_max_minutes:1440})),/跨交易日/);
  const r=await rig();try{r.engine.plan!.created_at=new Date(now.getTime()-86400000).toISOString();
    await r.engine.tick(now);assert.equal(r.store.orders().length,0);assert.match(r.engine.decisionStates.get('9001')!.reason,/舊交易日/);
  }finally{await r.engine.close();r.store.close();}
});
test('portfolio idle attribution distinguishes unsettled funds and a daily-loss lock without counting them as spendable cash',()=>{
  const a=account();a.cash='10000';a.settlement_credits='90000';const settings=SettingsSchema.parse({}),t=new EntryDiagnosticTracker();
  const states=new Map([['9001',{state:'BLOCKED',reason:'資金不足，已扣除交割款及掛單占用',source:'RULE'}]]);
  t.monitor(states,{account:a,settings,qualified:1,healthy:true,dailyLoss:false,market:true});
  t.monitor(states,{account:a,settings,qualified:1,healthy:true,dailyLoss:true,market:true});
  const r=t.report([]).capital_idle!;assert.equal(r.samples,2);
  assert.equal(r.reasons.find(c=>c.category==='SETTLEMENT')!.samples,1);
  assert.equal(r.reasons.find(c=>c.category==='DAILY_LOSS')!.samples,1);
  assert.equal(r.average_target_gap_twd,'50000.0000');assert.equal(a.cash,'10000');
});
