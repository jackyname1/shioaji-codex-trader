import test from 'node:test';
import assert from 'node:assert/strict';
import {SettingsSchema,d,type Analysis,type Decision,type Features,type Snapshot} from '../src/core/models.js';
import {entryWindow} from '../src/core/entry-window.js';
import {EntryDiagnosticTracker} from '../src/core/entry-diagnostics.js';
import {entryDiagnosticText} from '../src/core/entry-diagnostics-text.js';
import {replayCapitalSettings} from '../src/core/capital.js';
import {runBacktest,BacktestRequestSchema,type ReplayFrame,type BacktestProgress} from '../src/core/backtest.js';
import {syntheticDataset,type HistoryPoint} from '../src/core/backtest-data.js';
import {analysisPrompt} from '../src/core/codex.js';
import {rig,now,quote,order,testSize} from './helpers.js';

const buy:Decision={symbol:'9001',action:'BUY',shares:30,limit_price:'30.3',entry_when:'BELOW',trigger_price:'30.2',conditions:[],
  smart:{stop_price:'29',take_profit:'35',trailing_activate:null,trailing_fraction:null},reason:'isolated signal'};
const features:Features={sufficient:true,sessions:60,asof:'2026-10-07',ma20:30.05};
const guard=(value:string):Decision['conditions']=>[{left:'LAST',operator:'GTE',right:'VALUE',value}];
test('price windows identify the logged impossible pullback and the one-price breakout without raising ceilings',()=>{
  const bad={...buy,limit_price:'950',trigger_price:'950',smart:{...buy.smart!,stop_price:'890'},
    conditions:[{left:'LAST',operator:'GTE',right:'MA20',value:null}] as Decision['conditions']};
  const w=entryWindow(bad,{...features,ma20:979.8},now);assert.equal(w.minimum,'980');assert.equal(w.maximum,'950');assert.match(w.issue,/無交集/);
  const breakout=entryWindow({...buy,entry_when:'ABOVE',trigger_price:'30.3'},features,now);
  assert.equal(breakout.minimum,'30.3');assert.equal(breakout.maximum,'30.3');assert.equal(breakout.narrow,true);assert.equal(breakout.issue,'');
  assert.equal(bad.limit_price,'950');
});
test('price-window strict bounds respect stock tick boundaries, while absent/future daily guards stay unknown',()=>{
  const decision={...buy,entry_when:'IMMEDIATE' as const,limit_price:'50',conditions:[{left:'LAST',operator:'LT',right:'VALUE',value:'50'}] as Decision['conditions']};
  assert.equal(entryWindow(decision,features,now).maximum,'49.95');
  decision.conditions=[{left:'LAST',operator:'GT',right:'VALUE',value:'50'}];assert.match(entryWindow(decision,features,now).issue,/最低 50.1／最高 50/);
  const dynamic={...buy,conditions:[{left:'LAST',operator:'GTE',right:'MA20',value:null}] as Decision['conditions']};
  assert.equal(entryWindow(dynamic,{...features,ma20:40,asof:'2026-10-09'},now).issue,'');
  assert.equal(entryWindow(dynamic,{...features,ma20:40,asof:'2026-10-08'},now).issue,'');
  assert.equal(entryWindow(dynamic,{...features,ma20:40,sufficient:false},now).issue,'');
});
test('contradictory entry prices never ask for sizing or create an intent; feedback explains the exact conflict',async()=>{
  const r=await rig();try{
    r.engine.setSettings({...r.s,codex_enabled:true});const plan=r.engine.plan!.analysis.decisions[0]!;
    Object.assign(plan,buy,{conditions:guard('31')});await r.engine.tick(now);
    assert.equal(r.engine.pendingExecutions.size,0);assert.equal(r.store.orders().length,0);
    assert.match(r.engine.decisionStates.get('9001')!.reason,/無交集/);
    const s=await r.engine.snapshot(now);assert.match(s.entry_feedback!.signals[0]!.window.issue,/無交集/);
  }finally{await r.engine.close();r.store.close();}
});
test('strategy quote snapshots expose only fresh, non-simulated observations at or before the decision time',async()=>{
  const r=await rig();try{
    r.broker.quotes=()=>[];r.engine.quotes.clear();
    r.engine.quotes.set('9001:true',quote());
    r.engine.quotes.set('9002:true',{...quote(),symbol:'9002',trade_at:new Date(now.getTime()+1000).toISOString()});
    r.engine.quotes.set('9003:true',{...quote(),symbol:'9003',book_at:new Date(now.getTime()-31000).toISOString()});
    r.engine.quotes.set('9004:true',{...quote(),symbol:'9004',simulated:true});
    const s=await r.engine.snapshot(now);assert.deepEqual(s.quotes?.map(q=>q.symbol),['9001']);
    assert.ok(s.quotes!.every(q=>Date.parse(q.trade_at)<=Date.parse(s.asof)));
    const prompt=analysisPrompt(s);assert.match(prompt,/quotes/);assert.match(prompt,/價格交集/);assert.match(prompt,/entry_feedback/);
  }finally{await r.engine.close();r.store.close();}
});
test('a price window becoming empty during model sizing invalidates the advice before any intent is saved',async()=>{
  const r=await rig();try{
    r.engine.setSettings({...r.s,codex_enabled:true});const plan=r.engine.plan!.analysis.decisions[0]!;
    Object.assign(plan,buy,{entry_when:'IMMEDIATE',conditions:[{left:'LAST',operator:'GTE',right:'MA20',value:null}]});
    r.engine.watchFeatures['9001']={...features,ma20:29.8};await r.engine.tick(now);
    const id=r.engine.nextExecutionId()!;assert.ok(id);const request=await r.engine.executionRequest(id,now);assert.ok(request);
    const advice=await testSize(request);r.engine.watchFeatures['9001']={...features,ma20:31};r.market.marketPrice='31';
    assert.equal(await r.engine.confirmExecution(id,advice,now),false);assert.equal(r.store.orders().length,0);
    assert.match(r.engine.decisionStates.get('9001')!.reason,/無交集/);
  }finally{await r.engine.close();r.store.close();}
});
test('active replay budgets leave saved live preferences intact and retain cost/risk requirements',()=>{
  const base=SettingsSchema.parse({mode:'live',auto_execute:false,max_order_fraction:'0.04',min_cash_fraction:'0.4',max_exposure_fraction:'0.6'});
  const before=JSON.stringify(base),active=replayCapitalSettings(base,'active');
  assert.equal(JSON.stringify(base),before);assert.equal(active.max_order_fraction,'0.20');assert.equal(active.min_cash_fraction,'0.20');
  assert.equal(active.max_exposure_fraction,'0.80');assert.equal(active.max_daily_buy_fraction,'0.60');assert.equal(active.target_exposure_fraction,'0.70');
  assert.equal(active.min_entry_reward_risk,'1.2');assert.equal(active.max_trade_risk_fraction,'0.0125');assert.equal(active.auto_execute,false);
  assert.equal(replayCapitalSettings(base,'custom'),base);assert.equal(BacktestRequestSchema.parse({start:'2026-01-05',end:'2026-01-05'}).entry_cadence,'scheduled');
});
test('entry diagnostics count strategy signals and orders once and label repeated monitor states as samples',()=>{
  const t=new EntryDiagnosticTracker();t.strategy({decisions:[buy,{...buy,symbol:'9002',conditions:guard('31')}],screening:null} as Analysis,{9001:features,9002:features},{},now);
  const states=new Map([['9001',{state:'WAIT',reason:'等待低於 30.2',source:'CODEX'}],['9002',{state:'BLOCKED',reason:'進場價格條件無交集',source:'CODEX'}]]);
  t.monitor(states);t.monitor(states);const report=t.report([order({filled:10,status:'PARTIAL'}),order({local_id:'other',filled:0,status:'CANCELLED'})]);
  assert.equal(report.buy_signals,2);assert.equal(report.invalid_windows,1);assert.equal(report.buy_orders,2);assert.equal(report.filled_buy_orders,1);
  assert.equal(report.waits.find(w=>w.reason.includes('價格／反彈'))!.samples,2);assert.match(entryDiagnosticText(report),/並非獨立機會或拒單數/);
  assert.match(entryDiagnosticText(undefined),/舊報表/);
});
function minute(at:string,price:string):HistoryPoint{return {symbol:'9001',at:new Date(at).toISOString(),open:price,high:price,low:price,close:price,volume_shares:1000000};}
test('minute entry catches a brief non-rebound opportunity missed by the five-minute grid, with later-event fills and one sizing request',async()=>{
  const day='2026-01-05',data=syntheticDataset(day,day);
  data.points=data.points.filter(p=>p.at<new Date(day+'T00:00:00+08:00').toISOString()&&p.symbol==='9001');
  for(const p of data.points)p.open=p.high=p.low=p.close='30';
  data.points.push(...[['09:15','31'],['09:16','30.1'],['09:17','30.1'],['09:20','31'],['13:30','31']].map(([clock,price])=>minute(day+'T'+clock+':00+08:00',price!)));
  const analyze=async(s:Snapshot):Promise<Analysis>=>({snapshot_id:s.snapshot_id,expires_at:new Date(Date.parse(s.asof)+60*60000).toISOString(),
    stance:s.review_only?'HOLD_ONLY':'BUY_ALLOWED',candidates:['9001'],decisions:s.review_only?[]:[{...buy,conditions:guard('29.8')}],screening:null,summary:'isolated brief opportunity'});
  const frames:ReplayFrame[]=[];let calls=0;
  const settings=SettingsSchema.parse({codex_enabled:true,watch_min_amount:'0'}),request={start:day,end:day,source:'sample',strategy:'codex',strategy_schedule:'fixed',strategy_times:['09:15'],capital_profile:'active'};
  const scheduled=await runBacktest({...request,entry_cadence:'scheduled'},data,settings,analyze,new AbortController().signal,undefined,undefined,undefined,undefined,async r=>{calls++;return testSize(r);});
  assert.equal(scheduled.orders.length,0);assert.equal(calls,0);
  const active=await runBacktest({...request,entry_cadence:'market'},data,settings,analyze,new AbortController().signal,undefined,undefined,f=>frames.push(f),undefined,async r=>{calls++;return testSize(r);});
  assert.equal(active.status,'COMPLETED');assert.equal(active.orders.length,1);assert.equal(calls,1);assert.match(active.orders[0]!.created_at,/01:16:00/);
  assert.ok(active.fills.every(f=>Date.parse(f.at)>Date.parse(active.orders[0]!.created_at)));assert.equal(active.entry_diagnostics!.buy_signals,1);
  assert.ok(frames.some(f=>f.at.includes('01:16:00')&&f.next_event_at?.includes('01:17:00')));assert.equal(active.settings.min_cash_fraction,'0.20');
});
test('controlled rising-price replay deploys more active capital and increases fixture net gains while respecting daily and single-order ceilings',async(t)=>{
  const start='2026-01-05',end='2026-01-06',data=syntheticDataset(start,end);
  data.points=data.points.filter(p=>['9001','9002','9003'].includes(p.symbol));
  for(const p of data.points){p.open=p.high=p.low=p.close=p.at.slice(0,10)===end?'31.5':'30';p.volume_shares=1000000;}
  const snapshots:Snapshot[]=[],progress:BacktestProgress[]=[];
  const analyze=async(s:Snapshot):Promise<Analysis>=>{snapshots.push(s);return {snapshot_id:s.snapshot_id,
    expires_at:new Date(Date.parse(s.asof)+60*60000).toISOString(),stance:s.review_only?'HOLD_ONLY':'BUY_ALLOWED',
    candidates:['9001','9002','9003'],screening:null,summary:'isolated shared signals and rising prices',
    decisions:s.review_only||s.account.positions.length?[]:['9001','9002','9003'].map(symbol=>({...buy,symbol,entry_when:'IMMEDIATE',limit_price:'30.3'}))};};
  const base=SettingsSchema.parse({codex_enabled:true,watch_min_amount:'0'}),request={start,end,source:'sample',strategy:'codex',strategy_schedule:'fixed',strategy_times:['09:10'],entry_cadence:'market'};
  const size=async(r:import('../src/core/execution.js').ExecutionRequest)=>{const lot=r.lots.find(l=>l.max_shares>0)!;
    const desired=Math.floor(Number(r.capital!.preferred_order_twd)/Number(lot.limit_price)),shares=Math.min(desired,lot.max_shares);
    return {request_id:r.request_id,symbol:r.symbol,action:r.action,shares,lot:lot.lot,limit_price:lot.limit_price,reason:'isolated full feasible allocation'};};
  const balanced=await runBacktest({...request,capital_profile:'balanced'},data,base,analyze,new AbortController().signal,undefined,undefined,undefined,undefined,size);
  const active=await runBacktest({...request,capital_profile:'active'},data,base,analyze,new AbortController().signal,p=>progress.push(p),undefined,undefined,undefined,size);
  assert.equal(active.status,'COMPLETED');assert.equal(balanced.status,'COMPLETED');assert.ok(d(active.metrics.net_pnl).gt(balanced.metrics.net_pnl));
  assert.ok(d(active.metrics.max_exposure_pct!).gt('55'));assert.ok(d(active.metrics.max_exposure_pct!).lt('80'));
  assert.ok(active.fills.filter(f=>f.action==='BUY').every(f=>d(f.amount).lte('20000')));
  assert.ok(d(active.fills.filter(f=>f.action==='BUY').reduce((s,f)=>s.plus(f.amount),d(0))).lte('60000'));
  assert.ok(progress.every(p=>p.effective_settings?.max_order_fraction==='0.20'));
  assert.ok(snapshots.some(s=>s.hard_limits.capital_profile==='active'));assert.equal(base.max_order_fraction,'0.10');
  t.diagnostic(JSON.stringify({fixture:'SYNTHETIC identical signals and rising prices; not historical profitability',
    balanced_peak_pct:balanced.metrics.max_exposure_pct,active_peak_pct:active.metrics.max_exposure_pct,balanced_net:balanced.metrics.net_pnl,active_net:active.metrics.net_pnl}));
});
