import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DecisionSchema,SmartSchema,SettingsSchema,d,type Decision,type SmartSpec,type Analysis,type Snapshot} from '../src/core/models.js';
import {trackEntry,entryReady,reboundExit,evaluate,updateProtection,trailingExit} from '../src/core/smart.js';
import {entryQualityIssues,rewardTarget} from '../src/core/costs.js';
import {Store} from '../src/core/store.js';
import {runBacktest,type ReplayFrame} from '../src/core/backtest.js';
import {syntheticDataset,type HistoryPoint} from '../src/core/backtest-data.js';
import {rig,now,quote,testSize} from './helpers.js';
import {analysisPrompt,codexOutputSchema} from '../src/core/codex.js';
import {workspaceRuntime} from '../src/desktop/workspace.js';
import type {DesktopState,RuntimeView} from '../src/desktop/shared.js';

const spec:SmartSpec={stop_price:'95',take_profit:null,reward_target:'115',trailing_activate:'110',trailing_fraction:'0.03'};
const decision:Decision={symbol:'9001',action:'BUY',shares:30,limit_price:'101',entry_when:'REBOUND',trigger_price:'100',
  rebound_fraction:'0.02',conditions:[],smart:spec,reason:'isolated rebound test'};
const at=(seconds:number)=>new Date(now.getTime()+seconds*1000);
const q=(price:string,seconds:number)=>({...quote(at(seconds)),last:price});
async function dispose(r:Awaited<ReturnType<typeof rig>>){await r.engine.close();r.store.close();}
function reboundPlan(r:Awaited<ReturnType<typeof rig>>):void {
  Object.assign(r.engine.plan!.analysis.decisions[0]!,{entry_when:'REBOUND',trigger_price:'29.5',rebound_fraction:'0.02',limit_price:'30.3',conditions:[]});
  r.engine.plan!.analysis.decisions[0]!.smart!.stop_price='28';
  r.store.set('plan',r.engine.plan);
}
test('structured rebound requires a BUY, bounded positive percentage and no stray rebound fields on ordinary triggers',()=>{
  assert.ok(DecisionSchema.parse(decision));
  for(const change of [{action:'SELL'},{action:'HOLD'},{rebound_fraction:null},{rebound_fraction:'0'},{rebound_fraction:'0.21'},
    {entry_when:'BELOW'},{entry_when:'IMMEDIATE'}])assert.throws(()=>DecisionSchema.parse({...decision,...change}));
  assert.ok(DecisionSchema.parse({...decision,entry_when:'BELOW',rebound_fraction:null}));
  assert.throws(()=>SmartSchema.parse({...spec,trailing_fraction:null}));
});
test('rebound arms at the threshold, tracks the actual lower low, and buys only after the exact percentage recovery',()=>{
  let t=trackEntry(undefined,decision,'a',q('101',0),now.toISOString());assert.equal(t.armed,false);
  t=trackEntry(t,decision,'a',q('100',1),now.toISOString());assert.equal(t.armed,true);assert.equal(entryReady(decision,'100',t),false);
  t=trackEntry(t,decision,'a',q('96',2),now.toISOString());assert.equal(t.low_water,'96');assert.equal(reboundExit(t,decision),'97.92');
  assert.equal(entryReady(decision,'97.9199',t),false);assert.equal(entryReady(decision,'97.92',t),true);
  t=trackEntry(t,decision,'a',q('94',3),now.toISOString());assert.equal(t.status,'INVALID');assert.equal(reboundExit(t,decision),null);
});
test('entry tracking ignores pre-plan, repeated and out-of-order trades and does not mix odd and common markets',()=>{
  let t=trackEntry(undefined,decision,'a',q('80',-1),now.toISOString());assert.equal(t.armed,false);
  t=trackEntry(t,decision,'a',q('99',1),now.toISOString());
  assert.deepEqual(trackEntry(t,decision,'a',q('70',1),now.toISOString()),t);
  assert.deepEqual(trackEntry(t,decision,'a',q('70',0),now.toISOString()),t);
  const common=trackEntry(t,decision,'a',{...q('101',2),odd:false},now.toISOString());assert.equal(common.armed,false);assert.equal(common.lot,'COMMON');
  assert.equal(trackEntry(t,decision,'b',q('101',2),now.toISOString()).armed,false);
});
test('entry state persists across restart, while a newly activated plan atomically starts a fresh low-water tracker',()=>{
  const dir=mkdtempSync(join(tmpdir(),'smart-state-')),path=join(dir,'state.sqlite');let s:Store|undefined;
  try{s=new Store(path);s.saveEntryTrack(trackEntry(undefined,decision,'a',q('96',1),now.toISOString()));s.close();s=new Store(path);
    assert.equal(reboundExit(s.entryTracks()[0],decision),'97.92');
    s.activatePlan({id:'b',created_at:now.toISOString(),analysis:{snapshot_id:'s',expires_at:at(300).toISOString(),stance:'BUY_ALLOWED',candidates:['9001'],decisions:[decision],summary:'new plan'}},[]);
    assert.deepEqual(s.entryTracks(),[]);
  }finally{s?.close();rmSync(dir,{recursive:true,force:true});}
});
test('trailing activates without selling, tracks new highs, then exits on the precise drawdown; reward target never sells',()=>{
  const p=updateProtection(undefined,'9001',spec,'a');
  assert.equal(evaluate(p,'109',at(1).toISOString()),'');assert.equal(p.trailing_armed,false);assert.equal(p.high_water,'109');
  assert.equal(evaluate(p,'110',at(2).toISOString()),'');assert.equal(p.trailing_armed,true);
  assert.equal(evaluate(p,'115',at(3).toISOString()),'');assert.equal(trailingExit(p),'111.55');
  assert.equal(evaluate(p,'111.5501',at(4).toISOString()),'');assert.equal(evaluate(p,'111.55',at(5).toISOString()),'TRAILING');
  assert.equal(evaluate(p,'94',at(6).toISOString()),'STOP');
  assert.equal(evaluate(p,'200',at(1).toISOString()),'');assert.equal(p.high_water,'115');
});
test('fixed stop takes priority over trailing and explicit fixed profit, including a gap below the stop threshold',()=>{
  const p=updateProtection(undefined,'9001',{...spec,take_profit:'116'},'a');evaluate(p,'115');
  assert.equal(evaluate(p,'90'),'STOP');assert.equal(evaluate(p,'116'),'TAKE_PROFIT');
});
test('legacy activated protection remains armed after reload and cannot loosen its stop or trailing drawdown',()=>{
  const s=new Store(':memory:');try{s.saveProtection({symbol:'9001',spec,high_water:'115',triggered:'',plan_id:'old'});
    const p=updateProtection(s.protections()[0],'9001',{...spec,stop_price:'90',trailing_activate:null,trailing_fraction:null},'new');
    assert.equal(p.spec.stop_price,'95');assert.equal(p.trailing_armed,true);assert.equal(p.high_water,'115');
    assert.equal(evaluate(p,'111'),'TRAILING');
  }finally{s.close();}
});
test('pure trailing supports fee/risk checks using an explicit forecast, and a lower executable profit prevents inflated reward',()=>{
  const s=SettingsSchema.parse({min_entry_reward_risk:'1.2'});
  assert.deepEqual(entryQualityIssues(100,'100',spec,s),[]);assert.equal(rewardTarget(spec),'115');
  assert.equal(rewardTarget({...spec,take_profit:'105',reward_target:'150'}),'105');
  assert.match(entryQualityIssues(100,'100',{...spec,take_profit:'105',reward_target:'150'},s).join(),/報酬風險比/);
  assert.match(entryQualityIssues(100,'100',{...spec,reward_target:null},s).join(),/缺少/);
});
test('rebound signal still requires the second model quantity turn, is invalidated by a fresh decline, and cannot duplicate',async()=>{
  const r=await rig();try{reboundPlan(r);r.engine.setSettings({...r.s,codex_enabled:true});
    r.market.marketPrice='29.5';await r.engine.tick(at(1));assert.equal(r.engine.pendingExecutions.size,0);
    r.market.marketPrice='29';await r.engine.tick(at(2));r.market.marketPrice='29.6';await r.engine.tick(at(3));
    const id=r.engine.nextExecutionId()!;assert.ok(id);assert.equal(r.store.orders().length,0);
    const input=await r.engine.executionRequest(id,at(3));assert.ok(input);r.market.marketPrice='29.1';
    assert.equal(await r.engine.confirmExecution(id,await testSize(input),at(4)),false);assert.equal(r.store.orders().length,0);
    assert.match(r.engine.decisionStates.get('9001')!.reason,/條件目前已不成立/);
    r.market.marketPrice='29.7';await r.engine.tick(at(200));const next=r.engine.nextExecutionId()!;assert.ok(next);
    const retry=await r.engine.executionRequest(next,at(200));assert.ok(retry);
    assert.equal(await r.engine.confirmExecution(next,await testSize(retry),at(200)),true);
    await r.engine.tick(at(203));await r.engine.tick(at(206));assert.equal(r.store.orders().filter(o=>o.action==='BUY').length,1);
  }finally{await dispose(r);}
});
test('paused entries keep their observed low, but missing/future/stale quotes cannot arm or submit',async()=>{
  const r=await rig();try{reboundPlan(r);r.engine.pauseEntries();r.market.marketPrice='29.1';await r.engine.tick(at(1));
    assert.equal(r.store.entryTracks()[0]!.low_water,'29.1');assert.equal(r.store.orders().length,0);
    const valid=r.market.quotes.bind(r.market);r.market.quotes=when=>valid(when).map(q=>({...q,last:'28',trade_at:at(100).toISOString()}));
    await r.engine.tick(at(2));assert.equal(r.store.entryTracks()[0]!.low_water,'29.1');
    r.market.quotes=when=>valid(when).map(q=>({...q,last:'28',trade_at:at(-300).toISOString()}));
    await r.engine.tick(at(3));assert.equal(r.store.entryTracks()[0]!.low_water,'29.1');
    r.market.quotes=valid;r.engine.pauseEntries(false);r.market.marketPrice='29.7';await r.engine.tick(at(4));
    assert.equal(r.store.orders().length,1);
  }finally{await dispose(r);}
});
test('rebound secondary guards and cash limits remain mandatory even with a completed bounce',async()=>{
  const r=await rig();try{reboundPlan(r);r.engine.plan!.analysis.decisions[0]!.conditions=[{left:'LAST',operator:'GTE',right:'VALUE',value:'31'}];
    r.market.marketPrice='29';await r.engine.tick(at(1));r.market.marketPrice='29.7';await r.engine.tick(at(2));
    assert.equal(r.store.orders().length,0);assert.match(r.engine.decisionStates.get('9001')!.reason,/LAST/);
    r.engine.plan!.analysis.decisions[0]!.conditions=[];const read=r.broker.account.bind(r.broker);
    r.broker.account=async date=>({...await read(date),cash:'30'});await r.engine.tick(at(3));
    assert.equal(r.store.orders().length,0);assert.match(r.engine.decisionStates.get('9001')!.reason,/日損失/);
  }finally{await dispose(r);}
});
test('tracking metadata is available to strategy snapshots and strict model schema includes nullable new fields',async()=>{
  const r=await rig();try{reboundPlan(r);r.market.marketPrice='29.1';await r.engine.tick(at(1),false);
    const s=await r.engine.snapshot(at(2));assert.equal(s.smart_tracking!.entries[0]!.low_water,'29.1');
    assert.match(analysisPrompt(s),/REBOUND/);assert.match(analysisPrompt(s),/reward_target/);
    const json=JSON.stringify(codexOutputSchema());assert.match(json,/rebound_fraction/);assert.match(json,/reward_target/);
  }finally{await dispose(r);}
});

function minute(at:string,price:string):HistoryPoint{return {symbol:'9001',at:new Date(at).toISOString(),open:price,close:price,high:price,low:price,volume_shares:1000000};}
function heldStore():Store {
  const store=new Store(':memory:');store.set('paper_ledger',{cash:'100000',lots:[{symbol:'9001',shares:20,price:'30',acquired:'2026-10-07'}],
    orders:[],lastEvents:{},charges:{},fills:[],credits:[]});return store;
}
test('protective trailing exits submit without a model turn and a late quantity reply cannot sell twice',async()=>{
  const r=await rig(heldStore());try{r.engine.setSettings({...r.s,codex_enabled:true});
    r.market.marketPrice='34';await r.engine.tick(at(1));r.engine.clearExecutions('isolated entry reset');
    r.engine.setAdvisorIssue('model unavailable');r.market.marketPrice='32';await r.engine.tick(at(2));
    assert.equal(r.engine.pendingExecutions.size,0);assert.equal(r.store.orders().length,1);
    assert.equal(r.store.orders()[0]!.exit_trigger,'TRAILING');
    await r.engine.tick(at(3));await r.engine.tick(at(4));
    assert.equal(r.broker.fills().filter(f=>f.action==='SELL').reduce((n,f)=>n+f.shares,0),20);
    assert.equal(r.store.orders().filter(o=>o.action==='SELL').length,1);
  }finally{await dispose(r);}
});
test('historical stop follows a fresh gap-down bid, keeps sellable and partial/cancel reconciliation, without a model sizing turn',async()=>{
  const store=heldStore();store.set('historical_replay',true);const r=await rig(store);
  try{r.engine.setSettings({...r.s,codex_enabled:true});r.market.marketPrice='28.5';await r.engine.tick(at(1));
    assert.equal(r.engine.pendingExecutions.size,0);assert.equal(r.store.orders().length,1);
    assert.equal(r.store.orders()[0]!.limit_price,'28.45');assert.equal(r.store.orders()[0]!.shares,20);
    await r.engine.tick(at(2));assert.equal(r.store.orders()[0]!.filled,17);
    r.market.marketPrice='28.2';await r.engine.tick(at(62));assert.equal(r.store.orders()[0]!.status,'CANCELLED');
    await r.engine.tick(at(63));assert.equal(r.store.orders().length,2);assert.equal(r.store.orders()[1]!.shares,3);
    assert.equal(r.store.orders()[1]!.limit_price,'28.15');await r.engine.tick(at(66));
    assert.equal(r.broker.fills().filter(f=>f.action==='SELL').reduce((n,f)=>n+f.shares,0),20);
  }finally{await dispose(r);}
});
test('deterministic protection survives model failure and still obeys the kill switch',async()=>{
  for(const block of ['advisor','kill']){
    const store=heldStore();store.set('historical_replay',true);const r=await rig(store);
    try{r.engine.setSettings({...r.s,codex_enabled:true});r.market.marketPrice='28.5';
      if(block==='advisor')r.engine.setAdvisorIssue('isolated model halt');
      if(block==='kill')r.engine.kill();
      await r.engine.tick(at(1));assert.equal(r.store.orders().length,block==='kill'?0:1);
      assert.equal(r.engine.pendingExecutions.size,0);
    }finally{await dispose(r);}
  }
});
test('a model failure arriving during the final account refresh cannot interrupt existing deterministic protection',async()=>{
  const store=heldStore();store.set('historical_replay',true);const r=await rig(store);
  try{r.engine.setSettings({...r.s,codex_enabled:true});r.market.marketPrice='28.5';
    const refresh=r.engine.refreshAccount.bind(r.engine);let reads=0;
    r.engine.refreshAccount=async date=>{const a=await refresh(date);if(++reads===3)r.engine.setAdvisorIssue('isolated halt during final refresh');return a;};
    await r.engine.tick(at(1));assert.equal(r.engine.advisorIssue,'isolated halt during final refresh');assert.equal(r.store.orders().length,1);
  }finally{await dispose(r);}
});
test('replay tracking panes never borrow current lows when displaying an old report or a legacy frame',()=>{
  const current=trackEntry(undefined,decision,'current',q('96',1),now.toISOString());
  const historical={...current,plan_id:'historical',low_water:'90'};
  const state={runtime:{mode:'paper',entry_tracks:[current],watch:{entries:[],changes:[]}} as unknown as RuntimeView,
    workspace_mode:'paper',simulation_scope:'replay',replay:{entry_tracks:[historical],at:now.toISOString(),plan:null},
    backtest_result:null,backtest_progress:{running:false,phase:'COMPLETED'},replay_paused:false} as unknown as DesktopState;
  assert.deepEqual(workspaceRuntime(state)!.entry_tracks,[historical]);
  delete state.replay!.entry_tracks;assert.deepEqual(workspaceRuntime(state)!.entry_tracks,[]);
  state.replay=null;assert.deepEqual(workspaceRuntime(state)!.entry_tracks,[]);
});
test('a fresh unheld plan discards an old sold position high; subsequent holding updates retain an armed high',async()=>{
  const store=new Store(':memory:');store.saveProtection({symbol:'9001',spec:{stop_price:'29',take_profit:'40',trailing_activate:'33',trailing_fraction:'0.03'},
    plan_id:'old',high_water:'39',trailing_armed:true,triggered:'TRAILING'});
  const r=await rig(store);try{assert.equal(r.store.protections()[0]!.high_water,'0');assert.equal(r.store.protections()[0]!.trailing_armed,false);
    await r.engine.tick(now);await r.engine.tick(at(3));r.market.marketPrice='34';await r.engine.tick(at(6));
    const s=await r.engine.snapshot(at(9)),a=r.engine.plan!.analysis;
    await r.engine.activate({...a,snapshot_id:s.snapshot_id,expires_at:at(1000).toISOString()},s,at(9));
    assert.equal(r.store.protections()[0]!.high_water,'34');assert.equal(r.store.protections()[0]!.trailing_armed,true);
  }finally{await dispose(r);}
});
test('minute replay catches an off-grid rebound, disallows same-day odd-lot exit, trails the next day and fills only a later event',async()=>{
  const start='2026-01-05',end='2026-01-06',data=syntheticDataset(start,end);
  data.points=data.points.filter(p=>p.at<new Date(start+'T00:00:00+08:00').toISOString()&&p.symbol==='9001');
  for(const p of data.points)p.open=p.high=p.low=p.close='30';data.names={9001:data.names['9001']!};
  data.points.push(...[
    [start+'T09:10:00+08:00','30'],[start+'T09:11:00+08:00','29.5'],[start+'T09:12:00+08:00','29'],
    [start+'T09:13:00+08:00','29.6'],[start+'T09:14:00+08:00','29.6'],[start+'T09:16:00+08:00','28'],
    [start+'T13:30:00+08:00','30'],[end+'T09:10:00+08:00','31'],[end+'T09:11:00+08:00','32'],
    [end+'T09:12:00+08:00','31'],[end+'T09:13:00+08:00','31'],[end+'T13:30:00+08:00','31'],
  ].map(([at,price])=>minute(at!,price!)));
  const frames:ReplayFrame[]=[],snapshots:Snapshot[]=[];let sizings=0;
  const analyze=async(s:Snapshot):Promise<Analysis>=>{snapshots.push(s);return {snapshot_id:s.snapshot_id,
    expires_at:new Date(Date.parse(s.asof)+6*3600000).toISOString(),stance:s.review_only?'HOLD_ONLY':'BUY_ALLOWED',candidates:['9001'],screening:null,summary:'synthetic minute-path fixture',
    decisions:s.review_only||s.account.positions.length?[]:[{...decision,limit_price:'30.3',trigger_price:'29.5',
      smart:{stop_price:'28.5',take_profit:null,reward_target:'33',trailing_activate:'31',trailing_fraction:'0.03'}}]};};
  const report=await runBacktest({start,end,source:'sample',strategy:'codex',strategy_schedule:'fixed',strategy_times:['09:10'],capital_profile:'balanced'},
    data,SettingsSchema.parse({codex_enabled:true,watch_min_amount:'0'}),analyze,new AbortController().signal,undefined,undefined,f=>frames.push(f),undefined,
    async r=>{sizings++;return {...await testSize(r),shares:100};});
  assert.equal(report.status,'COMPLETED');assert.equal(report.version,'0.2.5');
  assert.equal(report.orders.filter(o=>o.action==='BUY').length,1,JSON.stringify({logs:report.logs.slice(-25),failures:report.failures,frames:frames.filter(f=>f.at.includes('2026-01-05T01:1')).map(f=>({at:f.at,tracks:f.entry_tracks,decisions:f.decisions}))}));assert.match(report.orders[0]!.created_at,/01:13:00/);
  assert.equal(report.orders.filter(o=>o.action==='SELL').length,1);assert.match(report.orders[1]!.created_at,/2026-01-06T01:12:00/);
  assert.ok(report.fills.every(f=>Date.parse(f.at)>Date.parse(report.orders.find(o=>o.local_id===f.order_id)!.created_at)));
  assert.equal(sizings,1,'Historical protection needs no extra model turn');assert.equal(report.metrics.execution_requests,1);
  assert.ok(report.metrics.smart_monitor_checks!>0);assert.ok(frames.some(f=>f.decisions?.some(d=>d.reason.includes('不可當沖'))));
  assert.ok(snapshots.every(s=>Date.parse(s.asof)<=Date.parse(report.asof)));assert.ok(d(report.metrics.total_costs!).gt(0));
});
