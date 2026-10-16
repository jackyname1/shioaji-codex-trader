import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {adaptiveSetups,adaptiveProtection,breakEvenPrice,costAwareSettings,optimizationSettings,preferredAllocation} from '../src/core/adaptive.js';
import {trackEntry,entryReady,evaluate,updateProtection} from '../src/core/smart.js';
import {entryQualityIssues,entryRiskIssues,roundTripEstimate} from '../src/core/costs.js';
import {SettingsSchema,d,type Features,type Decision,type Analysis} from '../src/core/models.js';
import {exitMetrics,idleCategory} from '../src/core/performance.js';
import {Store} from '../src/core/store.js';
import {Engine} from '../src/core/engine.js';
import {programAnalysis} from '../src/core/program-strategy.js';
import {HistoricalMarket,validateDataset,syntheticDataset,type HistoryDataset} from '../src/core/backtest-data.js';
import {runBacktest} from '../src/core/backtest.js';
import {executionLot,type ExecutionTicket} from '../src/core/execution.js';
import {Risk} from '../src/core/risk.js';
import {TradingCalendar} from '../src/core/calendar.js';
import {rig,now,quote,account,order,snapshot,instrument} from './helpers.js';
const f:Features={sufficient:true,sessions:100,asof:'2026-10-07',ma5:102,ma20:100,ma60:95,atr14:4,
  support20:94,resistance20:104,rsi14:60,volume_ratio20:1.5,return20:.1,daily_amount:'100000000'};
const q=(price:string,seconds=0)=>({...quote(new Date(now.getTime()+seconds*1000)),last:price,bid:price,ask:price,bid_shares:999,ask_shares:999});
const spec={stop_price:'95',take_profit:'120',trailing_activate:null,trailing_fraction:null};
const reb:Decision={symbol:'9001',action:'BUY',shares:30,limit_price:'103',entry_when:'REBOUND',trigger_price:'100',
  rebound_fraction:'0.01',smart:spec,reason:'isolated',tracking_timeout_minutes:5,confirmation_ticks:2,confirmation_seconds:30};
const position={symbol:'9001',shares:100,sellable:100,average_price:'100',last_price:'100'};
async function dispose(r:Awaited<ReturnType<typeof rig>>){await r.engine.close();r.store.close();}
test('three parallel setups use completed features, distinct confirmation rules and frozen, evidence-based targets',()=>{
  const setups=adaptiveSetups('9001',{...f,atr14:8,resistance20:110},q('103'),now);
  assert.deepEqual(new Set(setups.map(s=>s.entry_strategy)),new Set(['PULLBACK_REBOUND','TREND_CONTINUATION','BREAKOUT_CONFIRM']));
  assert.ok(setups.every(s=>s.confirmation_ticks===2&&s.confirmation_seconds===30));
  const breakout=setups.find(s=>s.entry_strategy==='BREAKOUT_CONFIRM')!;
  assert.equal(breakout.smart!.take_profit,'118');assert.equal(breakout.trigger_price,'110.5');
  assert.equal(adaptiveSetups('9001',{...f,asof:'2026-10-09'},q('101'),now).length,0);
  assert.equal(adaptiveSetups('9001',{...f,ma60:undefined},q('101'),now).length,0);
  assert.equal(adaptiveSetups('9001',{...f,rsi14:90},q('101'),now).length,0);
  assert.equal(adaptiveSetups('9001',f,q('130'),now).length,0);
});
test('rebound preserves the low across price updates, confirms different trades and cannot rearm itself after expiry',()=>{
  let t=trackEntry(undefined,reb,'p',q('100'),now.toISOString());
  t=trackEntry(t,reb,'p',q('98',10),now.toISOString());assert.equal(t.low_water,'98');
  t=trackEntry(t,reb,'p',q('99',20),now.toISOString());assert.equal(t.state,'CONFIRMING');
  assert.equal(entryReady(reb,'99',t),false);
  assert.deepEqual(trackEntry(t,reb,'p',q('110',20),now.toISOString()),t);
  t=trackEntry(t,reb,'p',q('99',50),now.toISOString());assert.equal(t.state,'READY');assert.equal(entryReady(reb,'99',t),true);
  t=trackEntry(t,reb,'p',q('100',301),now.toISOString());assert.equal(t.state,'EXPIRED');
  t=trackEntry(t,reb,'p',q('99',302),now.toISOString());assert.equal(t.state,'EXPIRED');
});
test('identical bounded signals can survive a new plan, while changed signals and stop breaches invalidate tracking',()=>{
  const t=trackEntry(undefined,reb,'p',q('98'),now.toISOString());
  const carried=trackEntry(t,reb,'next',q('99',10),new Date(now.getTime()+10000).toISOString());assert.equal(carried.low_water,'98');
  const changed=trackEntry(t,{...reb,trigger_price:'97'},'next',q('99',10),now.toISOString());assert.equal(changed.armed,false);
  const invalid=trackEntry(t,reb,'p',q('94',11),now.toISOString());assert.equal(invalid.state,'INVALID');
  assert.equal(entryReady(reb,'100',invalid),false);
});
test('adaptive protection covers fee/tax/slippage, ratchets its floor and latches exits until inventory is cleared',()=>{
  const s=costAwareSettings(SettingsSchema.parse({adaptive_exits:true}),true);
  const p=adaptiveProtection(updateProtection(undefined,'9001',spec,'p'),position,{...f,atr14:2},s,'10020');
  assert.ok(d(breakEvenPrice(position,s,'10020')).gt(100));
  assert.equal(evaluate(p,'103',q('103',1).trade_at),'');assert.equal(p.breakeven_armed,true);
  const early=p.protective_floor!;assert.ok(d(early).gte(p.spec.breakeven_price!));
  evaluate(p,'108',q('108',2).trade_at);assert.equal(p.trailing_armed,true);const raised=p.protective_floor!;
  assert.ok(d(raised).gt(early));assert.equal(evaluate(p,'107.9',q('107.9',3).trade_at),'');
  const next=adaptiveProtection(p,position,{...f,atr14:8},s,'10020');assert.ok(d(next.protective_floor!).gte(raised));
  assert.equal(evaluate(next,'104',q('104',4).trade_at),'TRAILING');
  assert.equal(evaluate(next,'110',q('110',5).trade_at),'TRAILING');
  assert.equal(evaluate(next,'90',q('90',6).trade_at),'STOP');
  assert.equal(evaluate(next,'120',q('120',7).trade_at),'STOP');
  const proceeds=d(p.spec.breakeven_price!).times(position.shares).times(d(1).minus(s.exit_slippage_fraction));
  assert.ok(proceeds.gt('10020'));
});
test('ratchet, activation, entry expiry and stop latch restore from a real persisted database',()=>{
  const dir=mkdtempSync(join(tmpdir(),'adaptive-state-')),path=join(dir,'state.db');
  let store=new Store(path);try{
    const s=SettingsSchema.parse({adaptive_exits:true}),p=adaptiveProtection(updateProtection(undefined,'9001',spec,'p'),position,f,s);
    evaluate(p,'110',q('110',1).trade_at);evaluate(p,'90',q('90',2).trade_at);store.saveProtection(p);
    store.saveEntryTrack(trackEntry(undefined,reb,'p',q('98'),now.toISOString()));
    store.close();store=new Store(path);const restored=store.protections()[0]!;
    assert.equal(restored.trailing_armed,true);assert.equal(restored.triggered,'STOP');assert.equal(restored.high_water,'110');
    assert.equal(evaluate(restored,'115',q('115',3).trade_at),'STOP');assert.equal(store.entryTracks()[0]!.low_water,'98');
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('sizing checks final quantity, exit slippage, gap stress and net-profit cost floors without inflating targets',()=>{
  const s=costAwareSettings(SettingsSchema.parse({max_trade_risk_fraction:'0.0125',min_entry_reward_risk:'1.2'}),true);
  const target=spec.take_profit;assert.deepEqual(entryRiskIssues(100,'100',spec,account(),s),[]);
  assert.match(entryRiskIssues(300,'100',spec,account(),s).join(),/停損風險/);
  assert.match(entryRiskIssues(150,'100',spec,account(),{...s,gap_stress_fraction:'0.1',max_gap_risk_fraction:'0.02'}).join(),/跳空/);
  assert.match(entryQualityIssues(1,'100',spec,s).join(),/成本|費/);
  assert.equal(spec.take_profit,target);
  assert.ok(d(roundTripEstimate(100,'100','120',s,'95').estimated_stop_loss!).gt(500));
});
test('dynamic allocation respects the soft exposure gap and cannot spend pending settlements',()=>{
  const s=SettingsSchema.parse({dynamic_allocation:true,max_order_fraction:'0.2',target_exposure_fraction:'0.7'});
  const a=account();a.cash='31000';a.positions=[{...position,shares:690,last_price:'100'}];
  const decision={...reb,entry_when:'IMMEDIATE' as const,rebound_fraction:null};
  assert.equal(preferredAllocation(decision,a,s),'1000');
  // Allocation is a preference. Actual funds/settlements remain bounded by executionLot and final Risk.check.
  a.cash='20000';a.settlement_credits='50000';const before=JSON.stringify(a);
  preferredAllocation(decision,a,s);assert.equal(JSON.stringify(a),before);
});
test('parallel entry strategies produce one selected symbol intent and retain actual tracking in snapshots',async()=>{
  const r=await rig();try{
    r.engine.setSettings({...r.s,adaptive_entries:true,dynamic_allocation:true,min_entry_reward_risk:'1.2'});
    const snap=await r.engine.snapshot(now);snap.features['9001']={...f,ma5:30,ma20:29.5,ma60:28,atr14:.5,support20:28.5,resistance20:32};
    await r.engine.activate({snapshot_id:snap.snapshot_id,expires_at:new Date(now.getTime()+7200000).toISOString(),stance:'BUY_ALLOWED',
      candidates:['9001'],decisions:[],screening:null,summary:'isolated parallel entry'} as Analysis,snap,now);
    await r.engine.tick(now);assert.equal(r.store.orders().length,0);
    await r.engine.tick(new Date(now.getTime()+30000));await r.engine.tick(new Date(now.getTime()+60000));
    assert.equal(r.store.orders().length,1);assert.equal(r.engine.adaptiveDecisions().length,1);
    await r.engine.tick(new Date(now.getTime()+90000));assert.equal(r.store.orders().length,1);
    assert.ok(r.store.entryTracks().some(t=>t.strategy==='TREND_CONTINUATION'));
  }finally{await dispose(r);}
});
test('a frozen rebound does not suppress a later confirmed trend in the same plan',async()=>{
  const r=await rig();try{
    r.engine.setSettings({...r.s,adaptive_entries:true,min_entry_reward_risk:'1.2'});r.market.depth=999;r.market.marketPrice='29.5';
    const snap=await r.engine.snapshot(now);snap.features['9001']={...f,ma5:30,ma20:29.5,ma60:28,atr14:.5,support20:28.5,resistance20:32};
    await r.engine.activate({snapshot_id:snap.snapshot_id,expires_at:new Date(now.getTime()+7200000).toISOString(),stance:'BUY_ALLOWED',
      candidates:['9001'],decisions:[],screening:null,summary:'late independent trend'} as Analysis,snap,now);
    await r.engine.tick(now);
    const rebound=structuredClone(r.engine.adaptiveCandidates().find(d=>d.entry_strategy==='PULLBACK_REBOUND'));
    assert.ok(rebound);assert.equal(r.engine.adaptiveCandidates().some(d=>d.entry_strategy==='TREND_CONTINUATION'),false);
    r.market.marketPrice='30';await r.engine.tick(new Date(now.getTime()+30000));
    assert.ok(r.engine.adaptiveCandidates().some(d=>d.entry_strategy==='TREND_CONTINUATION'));
    assert.deepEqual(r.engine.adaptiveCandidates().find(d=>d.entry_strategy==='PULLBACK_REBOUND'),rebound);
    await r.engine.tick(new Date(now.getTime()+60000));await r.engine.tick(new Date(now.getTime()+90000));
    const buys=r.store.orders().filter(o=>o.action==='BUY');assert.equal(buys.length,1);assert.equal(buys[0]!.entry_strategy,'TREND_CONTINUATION');
  }finally{await dispose(r);}
});
test('program order prices follow the executable ask with bounded slippage, not an unnecessarily high setup ceiling',()=>{
  const decision:Decision={...reb,entry_strategy:'PULLBACK_REBOUND',limit_price:'32',smart:{...spec,stop_price:'29',take_profit:'35'}};
  const ticket:ExecutionTicket={id:'bounded',key:'',queued_at:now.toISOString(),state:'QUEUED',order:order({limit_price:'32'}),
    source:'RULE',condition:decision,smart:decision.smart!,trigger:'test',settings_key:'',generation:0};
  const s=SettingsSchema.parse({mode:'demo',simulation_slippage_fraction:'0.001',min_entry_reward_risk:'1.2'});
  const db=new Store(':memory:');try{
    const risk=new Risk(s,new TradingCalendar(db,true)),before=JSON.stringify(decision),bounds=executionLot(ticket,quote(),account(),instrument(),risk,now,'100000',undefined);
    assert.equal(bounds.limit_price,'30.1');assert.ok(bounds.max_shares>0);assert.equal(JSON.stringify(decision),before);
    const capped=executionLot({...ticket,condition:{...decision,limit_price:'30.05'}},quote(),account(),instrument(),risk,now,'100000',undefined);
    assert.equal(capped.limit_price,'30.05');
  }finally{db.close();}
});
test('infeasible buys are preflighted and refusals do not repeat merely because audit messages scroll away',async()=>{
  const r=await rig();try{
    r.engine.setSettings({...r.s,codex_enabled:true,min_entry_reward_risk:'10'});
    for(let i=0;i<8;i++){r.engine.log('OTHER','noise '+i);await r.engine.tick(new Date(now.getTime()+i*3000));}
    assert.equal(r.engine.pendingExecutions.size,0);assert.equal(r.store.orders().length,0);
    assert.equal(r.store.logs(200).filter(l=>l.includes('RISK:')).length,1);
  }finally{await dispose(r);}
});
test('daily-loss lock survives a price recovery and restart, while the next date has a separate lock',async()=>{
  const store=new Store(':memory:');store.set('paper_ledger',{cash:'70000',lots:[{symbol:'9001',shares:1000,price:'30',acquired:'2026-10-07'}],orders:[],lastEvents:{},charges:{}});
  const r=await rig(store);try{
    r.engine.pauseEntries();r.market.marketPrice='27';await r.engine.tick(new Date(now.getTime()+1000));
    assert.ok(r.store.get('daily_loss_hit_2026-10-08'));r.market.marketPrice='30';await r.engine.tick(new Date(now.getTime()+2000));
    const restored=new Engine(r.store,r.broker,r.engine.settings,r.calendar);await restored.start(new Date(now.getTime()+3000));
    assert.ok(restored.store.get('daily_loss_hit_2026-10-08'));assert.equal(restored.store.get('daily_loss_hit_2026-10-09'),undefined);
  }finally{await dispose(r);}
});
test('paper fills require a later fresh nonfuture event and adverse slippage must remain within the limit',async()=>{
  const r=await rig();try{
    r.engine.setSettings({...r.s,simulation_slippage_fraction:'0.001'});
    await r.engine.tick(now);assert.equal(r.store.orders().length,1);
    r.broker.quotes(now);assert.equal(r.broker.fills().length,0);
    r.market.quotes=()=>[{...quote(),trade_at:new Date(now.getTime()+60000).toISOString()}];
    r.broker.quotes(new Date(now.getTime()+1000));assert.equal(r.broker.fills().length,0);
    r.market.quotes=at=>[{...quote(at),ask:'30.05'}];r.broker.quotes(new Date(now.getTime()+2000));assert.equal(r.broker.fills().length,0);
    r.market.quotes=at=>[{...quote(at),ask:'29.9',bid:'29.85',last:'29.9'}];r.broker.quotes(new Date(now.getTime()+3000));
    assert.equal(r.broker.fills()[0]!.price,'29.95');assert.ok(d(r.broker.fills()[0]!.price).lte('30.05'));
  }finally{await dispose(r);}
});
test('limit-down history does not invent a buyer; an explicitly recorded bid remains usable',async()=>{
  const point=(at:string,close:string)=>({symbol:'9001',at,open:close,high:close,low:close,close,volume_shares:1000000});
  const data:HistoryDataset={source:'isolated',synthetic:true,frequency:'MINUTE',names:{},limitations:[],points:[
    point('2026-10-07T05:30:00.000Z','100'),point(now.toISOString(),'90')]};
  const market=new HistoricalMarket(validateDataset(data),'.01');await market.subscribe(['9001'],false);
  assert.equal(market.quotes(now)[0]!.bid,'0');assert.equal(market.quotes(now)[0]!.bid_shares,0);
  data.points[1]={...data.points[1]!,bid:'90',ask:'90.1',bid_shares:10,ask_shares:10};
  const known=new HistoricalMarket(validateDataset(data),'.01');await known.subscribe(['9001'],false);
  assert.equal(known.quotes(now)[0]!.bid,'90');assert.equal(known.quotes(now)[0]!.bid_shares,10);
});
test('exit statistics aggregate partial executions by order and explain null Profit Factor when there is no losing exit',()=>{
  const fill=(id:string,pnl:string)=>({id,order_id:id[0]!,at:now.toISOString(),symbol:'9001',action:'SELL' as const,lot:'ODD' as const,
    purpose:'PROTECTION' as const,shares:1,price:'100',amount:'100',fee:'1',tax:'1',realized_pnl:pnl,exit_trigger:'TRAILING'});
  const m=exitMetrics([fill('a1','10'),fill('a2','-1'),fill('b1','-3')]);
  assert.equal(m.exit_orders,2);assert.equal(m.win_rate_pct,'50.0000');assert.equal(m.profit_factor,'3.0000');assert.equal(m.exit_triggers.TRAILING,2);
  assert.equal(exitMetrics([fill('a1','10')]).profit_factor,null);
});
test('optimization variants never alter mode/authority or original saved settings; idle categories remain distinguishable',()=>{
  const s=SettingsSchema.parse({mode:'live',auto_execute:false}),before=JSON.stringify(s);
  for(const mode of ['baseline','entries','exits','allocation','integrated'] as const){
    const next=optimizationSettings(s,mode);assert.equal(next.mode,'live');assert.equal(next.auto_execute,false);
  }
  assert.equal(JSON.stringify(s),before);
  assert.equal(idleCategory('扣費後報酬風險比不足'),'REWARD_RISK');assert.equal(idleCategory('待交割'),'SETTLEMENT');
  assert.equal(idleCategory('達到日損失限制'),'DAILY_LOSS');assert.equal(idleCategory('等待行情'),'DATA');
});

test('a waiting model pullback cannot monopolize the symbol when an independent trend is confirmed and affordable',async()=>{
  const r=await rig();try{
    r.engine.setSettings({...r.s,adaptive_entries:true,dynamic_allocation:true,min_entry_reward_risk:'1.2'});
    r.market.depth=999;
    const snap=await r.engine.snapshot(now);
    snap.features['9001']={...f,ma5:30,ma20:29.5,ma60:28,atr14:.5,support20:28.5,resistance20:32};
    const model:Decision={symbol:'9001',action:'BUY',shares:30,limit_price:'30.1',entry_when:'REBOUND',
      trigger_price:'27',rebound_fraction:'0.01',smart:{stop_price:'26',take_profit:'35',trailing_activate:null,trailing_fraction:null},conditions:[],reason:'wait for model pullback'};
    await r.engine.activate({snapshot_id:snap.snapshot_id,expires_at:new Date(now.getTime()+7200000).toISOString(),stance:'BUY_ALLOWED',
      candidates:['9001'],decisions:[model],screening:null,summary:'independent entry competition'} as Analysis,snap,now);
    await r.engine.tick(now);assert.equal(r.store.orders().length,0);
    await r.engine.tick(new Date(now.getTime()+30000));await r.engine.tick(new Date(now.getTime()+60000));
    const buys=r.store.orders().filter(o=>o.action==='BUY');assert.equal(buys.length,1);
    assert.equal(buys[0]!.entry_strategy,'TREND_CONTINUATION');assert.ok(d(buys[0]!.limit_price).lte('30.1'));
    assert.equal(r.engine.plan!.analysis.decisions[0]!.trigger_price,'27');
    const feedback=await r.engine.snapshot(new Date(now.getTime()+60000));
    assert.equal(feedback.entry_feedback?.signals.find(s=>s.symbol==='9001')?.source,'PROGRAM');
    assert.ok(feedback.parallel_entries?.some(d=>d.entry_strategy==='TREND_CONTINUATION'));
    await r.engine.tick(new Date(now.getTime()+90000));assert.equal(r.store.orders().filter(o=>o.action==='BUY').length,1);
  }finally{await dispose(r);}
});
function priorPositionStore():Store{
  const store=new Store(':memory:');
  store.set('paper_ledger',{cash:'97000',lots:[{symbol:'9001',shares:100,price:'30',cost:'3000',acquired:'2026-10-07'}],
    orders:[],lastEvents:{},charges:{}});
  return store;
}
test('a stable fresh bid can execute a bounded protective sell with adverse slippage and partial depth',async()=>{
  const r=await rig(priorPositionStore());try{
    r.engine.setSettings({...r.s,adaptive_exits:true,exit_slippage_fraction:'0.001',simulation_slippage_fraction:'0.001'});
    r.market.marketPrice='28.8';
    await r.engine.tick(now);
    const pending=r.store.orders().find(o=>o.purpose==='PROTECTION')!;
    assert.ok(pending);assert.ok(d(pending.limit_price).gte('27'));assert.ok(d(pending.limit_price).lt('28.75'));
    assert.equal(r.broker.fills().length,0);
    for(let n=1;n<=7;n++)await r.engine.tick(new Date(now.getTime()+n*30000));
    const sells=r.broker.fills().filter(f=>f.action==='SELL');
    assert.equal(sells.reduce((sum,f)=>sum+f.shares,0),100);
    assert.ok(sells.every(f=>d(f.price).gte(pending.limit_price)&&d(f.price).lte('28.75')));
    assert.equal(r.store.orders().filter(o=>o.purpose==='PROTECTION').length,1);
  }finally{await dispose(r);}
});
test('a real positive bid at limit down remains executable while adverse slippage cannot cross the exchange floor',async()=>{
  const r=await rig(priorPositionStore());try{
    r.engine.setSettings({...r.s,adaptive_exits:true,exit_slippage_fraction:'0.001',simulation_slippage_fraction:'0.001'});
    r.market.quotes=(at:Date)=>[{...quote(at),last:'27',bid:'27',ask:'0',bid_shares:17,ask_shares:0}];
    await r.engine.tick(now);await r.engine.tick(new Date(now.getTime()+30000));
    const sells=r.broker.fills().filter(f=>f.action==='SELL');
    assert.ok(sells.length>0);assert.ok(sells.every(f=>f.price==='27'));
    assert.ok(r.store.orders().filter(o=>o.purpose==='PROTECTION').every(o=>o.limit_price==='27'));
  }finally{await dispose(r);}
});

test('a regenerated program policy stays inside its rule schema when the hard order budget is raised to 25 percent',()=>{
  const settings=SettingsSchema.parse({dynamic_allocation:true,max_order_fraction:'0.25'});
  const analysis=programAnalysis(snapshot(),settings);
  assert.equal(analysis.screening!.entry!.allocation_fraction,'0.20');
  assert.equal(settings.max_order_fraction,'0.25');
});
test('an identical bounded program signal preserves its first confirmation and expiry across a new plan',async()=>{
  const r=await rig();try{
    r.engine.setSettings({...r.s,adaptive_entries:true,dynamic_allocation:true,min_entry_reward_risk:'1.2'});
    const activate=async(at:Date)=>{
      const snap=await r.engine.snapshot(at);
      snap.features['9001']={...f,ma5:30,ma20:29.5,ma60:28,atr14:.5,support20:28.5,resistance20:32};
      await r.engine.activate({snapshot_id:snap.snapshot_id,expires_at:new Date(at.getTime()+7200000).toISOString(),stance:'BUY_ALLOWED',
        candidates:['9001'],decisions:[],screening:null,summary:'bounded program continuity'} as Analysis,snap,at);
    };
    await activate(now);await r.engine.tick(now);
    const first=r.store.entryTracks().find(t=>t.strategy==='TREND_CONTINUATION'&&t.lot==='ODD')!;
    assert.equal(first.confirmations,1);
    await activate(new Date(now.getTime()+20000));await r.engine.tick(new Date(now.getTime()+30000));
    const carried=r.store.entryTracks().find(t=>t.strategy==='TREND_CONTINUATION'&&t.lot==='ODD')!;
    assert.equal(carried.started_at,first.started_at);assert.equal(carried.expires_at,first.expires_at);
    assert.equal(carried.state,'READY');assert.equal(r.store.orders().filter(o=>o.action==='BUY').length,1);
  }finally{await dispose(r);}
});
