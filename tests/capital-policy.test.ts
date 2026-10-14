import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SettingsSchema,storedSettings,d,twDay,type Analysis,type SmartSpec,type Snapshot} from '../src/core/models.js';
import {capitalSnapshot,orderBudget,replayCapitalSettings} from '../src/core/capital.js';
import {roundTripEstimate,entryQualityIssues,entryRiskIssues} from '../src/core/costs.js';
import {executionLot,type ExecutionTicket,type ExecutionRequest} from '../src/core/execution.js';
import {Risk} from '../src/core/risk.js';
import {Store} from '../src/core/store.js';
import {TradingCalendar} from '../src/core/calendar.js';
import {validateAnalysis,demoAnalysis} from '../src/core/strategy.js';
import {syntheticDataset} from '../src/core/backtest-data.js';
import {runBacktest,formatBacktestReport} from '../src/core/backtest.js';
import {analysisPrompt} from '../src/core/codex.js';
import {account,instrument,now,order,quote,rig,snapshot} from './helpers.js';

const smart:SmartSpec={stop_price:'95',take_profit:'110',trailing_activate:null,trailing_fraction:null};
function budgetRig(){
  const store=new Store(':memory:'),calendar=new TradingCalendar(store,true);
  const s=replayCapitalSettings(SettingsSchema.parse({mode:'demo',auto_execute:true,whole_lots:true}),'balanced');
  const q={...quote(),last:'100',bid:'99.9',ask:'100',bid_shares:100000,ask_shares:100000};
  const m={...instrument(),reference:'100',limit_down:'90',limit_up:'110'};
  const ticket:ExecutionTicket={id:'entry',key:'entry',queued_at:now.toISOString(),state:'QUEUED',
    order:order({limit_price:'103',shares:150}),source:'CODEX',trigger:'entry',smart,settings_key:'',generation:0};
  return {store,s,q,m,ticket,risk:new Risk(s,calendar)};
}
test('equity budgets and persisted legacy budgets use one explicit denominator, with no live profile widening',()=>{
  const fresh=SettingsSchema.parse({}),raw={...fresh};delete (raw as Partial<typeof raw>).order_budget_basis;
  const legacy=storedSettings(raw);
  assert.equal(orderBudget('100000',fresh).toFixed(),'10000');assert.equal(orderBudget('100000',legacy).toFixed(),'7500');
  assert.equal(legacy.order_budget_basis,'AFTER_RESERVE');assert.equal(storedSettings(legacy).order_budget_basis,'AFTER_RESERVE');
  const balanced=replayCapitalSettings(legacy,'balanced');assert.equal(orderBudget('100000',balanced).toFixed(),'15000');
  assert.equal(balanced.max_daily_buy_fraction,'0.40');assert.equal(legacy.max_daily_buy_fraction,'0.20');
  assert.equal(replayCapitalSettings(legacy,'custom'),legacy);
});
test('capital snapshots reserve open buys and settlements and clip the soft target to the exposure ceiling',()=>{
  const a=account();a.settlement_credits='10000';a.settlement_debits='1000';
  a.positions=[{symbol:'9001',shares:100,sellable:100,average_price:'100',last_price:'100'}];
  a.orders=[order({symbol:'9002',shares:100,limit_price:'100',status:'PARTIAL',filled:20})];
  const s=SettingsSchema.parse({target_exposure_fraction:'0.9',max_exposure_fraction:'0.50'});
  const c=capitalSnapshot(a,s);assert.equal(c.order_limit_twd,'11900');assert.equal(c.reserved_buy_principal_twd,'8000');
  assert.equal(c.reserved_buy_cash_twd,'8020');assert.equal(c.exposure_twd,'18000');
  assert.equal(c.target_exposure_twd,'59500');assert.equal(c.target_gap_twd,'41500');
});
test('entry economics include both fees and taxes at target and stop, and reject the logged weak reward/risk setup',()=>{
  const s=replayCapitalSettings(SettingsSchema.parse({}),'balanced');
  const spec={...smart,stop_price:'210',take_profit:'237'};
  const c=roundTripEstimate(32,'227','237',s,'210');assert.equal(c.estimated_net_target_gain,'257');
  assert.equal(c.estimated_stop_loss,'605');assert.ok(d(c.estimated_reward_risk!).lt('.43'));
  assert.match(entryQualityIssues(32,'227',spec,s).join(),/報酬風險比/);
  assert.match(entryQualityIssues(1,'100',smart,s).join(),/不足覆蓋/);
  assert.match(entryQualityIssues(150,'100',{...smart,take_profit:null},s).join(),/缺少/);
  assert.deepEqual(entryRiskIssues(150,'100',smart,account(),s),[]);
  assert.match(entryRiskIssues(200,'100',smart,account(),s).join(),/停損風險預算/);
});
test('sizing finds viable lot quantities, preserves cash/daily bounds and reports the cost minimum to the model',()=>{
  const r=budgetRig();try{
    const lot=executionLot(r.ticket,r.q,account(),r.m,r.risk,now,'100000',undefined);
    assert.equal(lot.max_shares,150);assert.ok(lot.min_shares!>1);assert.ok(lot.min_shares!<150);
    assert.deepEqual(entryQualityIssues(lot.min_shares!,'100',smart,r.s),[]);
    assert.ok(d(lot.cost_at_max_shares!.estimated_reward_risk!).gte('1.2'));
    const daily=account();daily.daily_buy_amount='35000';
    const reduced=executionLot(r.ticket,r.q,daily,r.m,r.risk,now,'100000',undefined);assert.equal(reduced.max_shares,50);
    const tiny={...r.s,max_trade_risk_fraction:'0.001'};
    const blocked=executionLot(r.ticket,r.q,account(),r.m,new Risk(tiny,r.risk.calendar),now,'100000',undefined);
    assert.equal(blocked.max_shares,0);assert.ok(blocked.reasons.length);
    const sell=executionLot({...r.ticket,smart:undefined,source:'PROTECTION',order:order({action:'SELL',shares:5})},r.q,
      {...account(),positions:[{symbol:'9001',shares:5,sellable:5,average_price:'100',last_price:'100'}]},r.m,r.risk,now,'100000',undefined);
    assert.equal(sell.max_shares,5);assert.equal(sell.min_shares,1);
  }finally{r.store.close();}
});
test('five postmarket HOLD protection examples become review text without granting execution authority',()=>{
  const s=SettingsSchema.parse({codex_enabled:true}),snap=snapshot();snap.review_only=true;
  for(const symbol of snap.universe.map(c=>c.symbol)){
    const a=demoAnalysis(snap,s,now);a.candidates=[];a.decisions=[{symbol,action:'HOLD',shares:0,limit_price:'30',
      entry_when:'IMMEDIATE',trigger_price:'0',conditions:[],smart:{...smart,stop_price:'29',take_profit:'35'},reason:'protection commentary'}];
    const p=validateAnalysis(a,snap,now,s);assert.equal(p.analysis.decisions[0]!.smart,null);assert.notEqual(a.decisions[0]!.smart,null);
    assert.equal(p.analysis.decisions[0]!.action,'HOLD');
  }
  const unknown=demoAnalysis(snap,s,now);unknown.decisions=[{symbol:'9999',action:'HOLD',shares:0,limit_price:'30',entry_when:'IMMEDIATE',trigger_price:'0',smart:null,reason:'unknown'}];
  assert.throws(()=>validateAnalysis(unknown,snap,now,s),/決策標的/);
  unknown.decisions[0]!.symbol='9001';unknown.decisions[0]!.action='SELL';unknown.decisions[0]!.shares=1;
  assert.throws(()=>validateAnalysis(unknown,snap,now,s),/盤後檢討不得/);
  const intraday={...snap,review_only:false};unknown.decisions[0]!.action='HOLD';unknown.decisions[0]!.smart={...smart,stop_price:'29',take_profit:'35'};unknown.candidates=[];
  assert.throws(()=>validateAnalysis(unknown,intraday,now,s),/決策標的/);
});
test('a smaller second-turn quantity that fails minimum-fee economics never creates an order',async()=>{
  const r=await rig();try{
    r.engine.setSettings({...replayCapitalSettings(r.s,'balanced'),codex_enabled:true});
    await r.engine.tick(now);const id=r.engine.nextExecutionId();assert.ok(id);const input=await r.engine.executionRequest(id,now);assert.ok(input);
    const lot=input.lots.find(l=>l.max_shares>0)!;assert.ok(lot.min_shares!>1);
    assert.equal(await r.engine.confirmExecution(id,{request_id:id,symbol:input.symbol,action:'BUY',shares:1,lot:lot.lot,
      limit_price:lot.limit_price,reason:'small size'},now),false);assert.equal(r.store.orders().length,0);
    assert.match(r.engine.decisionStates.get(input.symbol)!.reason,/費|報酬風險比/);
  }finally{await r.engine.close();r.store.close();}
});
test('final account refresh repeats the per-trade loss guard before persisting any intent',async()=>{
  const r=await rig();try{
    r.engine.setSettings({...r.s,codex_enabled:true,min_entry_reward_risk:'1.2',max_trade_risk_fraction:'0.001'});
    await r.engine.tick(now);const id=r.engine.nextExecutionId();assert.ok(id);const input=await r.engine.executionRequest(id,now);assert.ok(input);
    const lot=input.lots.find(l=>l.max_shares>0)!;const shares=lot.max_shares;
    let reads=0;const read=r.broker.account.bind(r.broker);r.broker.account=async at=>{
      const a=await read(at);if(++reads===2)a.cash='60000';return a;
    };
    assert.equal(await r.engine.confirmExecution(id,{request_id:id,symbol:input.symbol,action:'BUY',shares,lot:lot.lot,
      limit_price:lot.limit_price,reason:'checked size'},now),false);assert.equal(r.store.orders().length,0);
    assert.match(r.engine.decisionStates.get(input.symbol)!.reason,/停損風險預算/);
  }finally{await r.engine.close();r.store.close();}
});
test('a controlled replay compares balanced and legacy allocation with the same signals, without exceeding deterministic limits',async(t)=>{
  const day='2026-01-05',data=syntheticDataset(day,day);for(const p of data.points){p.open=p.high=p.low=p.close='30';p.volume_shares=1000000;}
  const snapshots:Snapshot[]=[];const analyst=async(s:Snapshot):Promise<Analysis>=>{
    snapshots.push(s);return {snapshot_id:s.snapshot_id,expires_at:new Date(Date.parse(s.asof)+120*60000).toISOString(),
      stance:s.review_only?'HOLD_ONLY':'BUY_ALLOWED',candidates:['9001','9002','9003'],screening:null,summary:'controlled three-signal fixture',
      decisions:s.review_only?[]:['9001','9002','9003'].map(symbol=>({symbol,action:s.account.positions.some(p=>p.symbol===symbol)?'HOLD' as const:'BUY' as const,
        shares:500,limit_price:'30.3',entry_when:'IMMEDIATE' as const,trigger_price:'0',conditions:[],reason:'controlled signal',
        smart:{stop_price:'29',take_profit:'36',trailing_activate:null,trailing_fraction:null}}))};
  };
  const size=async(r:ExecutionRequest)=>{
    const lot=r.lots.find(l=>l.max_shares>0)!;const desired=Math.floor(Number(r.capital!.preferred_order_twd)/Number(lot.limit_price));
    const shares=Math.min(lot.max_shares,desired);return {request_id:r.request_id,symbol:r.symbol,action:shares>=(lot.min_shares??1)?r.action:'HOLD' as const,
      shares:shares>=(lot.min_shares??1)?shares:0,lot:lot.lot,limit_price:lot.limit_price,reason:'controlled budget-based size'};
  };
  const base=SettingsSchema.parse({codex_enabled:true,order_budget_basis:'AFTER_RESERVE'}),input={start:day,end:day,source:'sample',strategy:'codex'};
  const legacy=await runBacktest({...input,capital_profile:'custom'},data,base,analyst,new AbortController().signal,undefined,undefined,undefined,undefined,size);
  const balanced=await runBacktest({...input,capital_profile:'balanced'},data,base,analyst,new AbortController().signal,undefined,undefined,undefined,undefined,size);
  assert.equal(legacy.status,'COMPLETED');assert.equal(balanced.status,'COMPLETED');
  t.diagnostic(JSON.stringify({fixture:'synthetic fixed signals',legacy_peak_pct:legacy.metrics.max_exposure_pct,balanced_peak_pct:balanced.metrics.max_exposure_pct,balanced_average_pct:balanced.metrics.average_exposure_pct}));
  assert.ok(d(balanced.metrics.max_exposure_pct!).gt(d(legacy.metrics.max_exposure_pct!).times('1.5')));
  assert.ok(d(balanced.metrics.max_exposure_pct!).lte('50'));assert.equal(balanced.metrics.exposure_samples,balanced.timeline!.length);
  assert.equal(balanced.settings.order_budget_basis,'EQUITY');assert.match(formatBacktestReport(balanced),/行情時點平均/);
  const byDay=new Map<string,number>();for(const f of balanced.fills.filter(f=>f.action==='BUY')){
    const day=twDay(new Date(f.at));byDay.set(day,(byDay.get(day)??0)+Number(f.amount));assert.ok(Number(f.amount)<=15000);
  }
  assert.ok([...byDay.values()].every(amount=>amount<=40000));assert.ok(snapshots.every(s=>s.capital));
  assert.match(analysisPrompt(snapshots[0]!),/order_limit_twd/);assert.equal(base.order_budget_basis,'AFTER_RESERVE');
});
