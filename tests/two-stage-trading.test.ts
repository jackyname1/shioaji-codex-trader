import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {rig,now,testSize,ControlledMarket,snapshot,settings} from './helpers.js';
import {TradingService} from '../src/core/service.js';
import {demoAnalysis,validateAnalysis} from '../src/core/strategy.js';
import {Store} from '../src/core/store.js';
import {SettingsSchema,type Analysis} from '../src/core/models.js';
import {runBacktest,type ReplayFrame} from '../src/core/backtest.js';
import {syntheticDataset} from '../src/core/backtest-data.js';
import {ReplayClock} from '../src/core/replay-clock.js';
import {workspaceRuntime,workspaceEvents} from '../src/desktop/workspace.js';
import type {DesktopState} from '../src/desktop/shared.js';
import {compactAnalystEvent} from '../src/core/codex.js';

async function enabled(){const r=await rig();r.engine.setSettings({...r.s,codex_enabled:true});return r;}
async function dispose(r:Awaited<ReturnType<typeof rig>>){await r.engine.close();r.store.close();}
async function request(r:Awaited<ReturnType<typeof rig>>){
  await r.engine.tick(now);const id=r.engine.nextExecutionId();assert.ok(id);
  const input=await r.engine.executionRequest(id,now);assert.ok(input);return {id,input};
}
test('a triggered reference quantity never sends until a second Codex turn; its actual quantity sends once and fills later',async()=>{
  const r=await enabled();try{
    await r.engine.tick(now);await r.engine.tick(new Date(now.getTime()+3000));
    assert.equal(r.engine.pendingExecutions.size,1);assert.equal(r.store.orders().length,0);
    const id=r.engine.nextExecutionId()!,input=(await r.engine.executionRequest(id,new Date(now.getTime()+3000)))!;
    assert.equal(input.condition!.shares,30);assert.equal(input.account.available_cash,'100000');
    const advice={...await testSize(input),shares:7};
    assert.equal(await r.engine.confirmExecution(id,advice,new Date(now.getTime()+3000)),true);
    assert.equal(r.store.orders()[0]!.shares,7);assert.equal(r.store.orders()[0]!.filled,0);
    assert.equal(await r.engine.confirmExecution(id,advice,new Date(now.getTime()+3000)),false);
    await r.engine.tick(new Date(now.getTime()+6000));
    assert.equal(r.store.orders().length,1);assert.equal(r.store.orders()[0]!.filled,7);
    assert.equal(r.engine.account!.positions[0]!.sellable,0);
    assert.ok(r.engine.watch.entries.some(w=>w.symbol==='9001'));
  }finally{await dispose(r);}
});
test('a price condition that reverses during Codex sizing invalidates the answer',async()=>{
  const r=await enabled();try{
    Object.assign(r.engine.plan!.analysis.decisions[0]!,{entry_when:'BELOW',trigger_price:'31'});
    const {id,input}=await request(r),advice=await testSize(input);r.market.marketPrice='31.5';
    assert.equal(await r.engine.confirmExecution(id,advice,new Date(now.getTime()+3000)),false);
    assert.equal(r.store.orders().length,0);assert.match(r.engine.decisionStates.get('9001')!.reason,/條件目前已不成立/);
  }finally{await dispose(r);}
});
test('cash and standing reservations are refreshed after the model reply, preventing an oversized stale recommendation',async()=>{
  const r=await enabled();try{
    const {id,input}=await request(r),advice=await testSize(input),read=r.broker.account.bind(r.broker);
    r.broker.account=async at=>({...await read(at),cash:'30',settlement_debits:'10',settlement_credits:'90000'});
    assert.equal(await r.engine.confirmExecution(id,advice,new Date(now.getTime()+3000)),false);
    assert.equal(r.store.orders().length,0);assert.match(r.engine.decisionStates.get('9001')!.reason,/現金/);
    await r.engine.tick(new Date(now.getTime()+6000));assert.equal(r.engine.pendingExecutions.size,0,'A refusal cannot immediately hammer Codex');
  }finally{await dispose(r);}
});
test('HOLD consumes no order intent and throttles repeat sizing until the retry interval',async()=>{
  const r=await enabled();try{
    const {id,input}=await request(r);assert.equal(await r.engine.confirmExecution(id,{...await testSize(input),action:'HOLD',shares:0,reason:'現金配置暫不適合'},now),false);
    await r.engine.tick(new Date(now.getTime()+3000));assert.equal(r.engine.pendingExecutions.size,0);assert.equal(r.store.orders().length,0);
    await r.engine.tick(new Date(now.getTime()+(r.s.cooldown_seconds+1)*1000));assert.equal(r.engine.pendingExecutions.size,1);
  }finally{await dispose(r);}
});
test('mismatched requests, reversed sides, over-budget quantities, oversized odd lots and unaligned prices cannot submit',async()=>{
  for(const override of [{request_id:'other'},{action:'SELL' as const},{shares:999},{shares:1000},{limit_price:'30.01'}]){
    const r=await enabled();try{const {id,input}=await request(r);
      assert.equal(await r.engine.confirmExecution(id,{...await testSize(input),...override},now),false);
      assert.equal(r.store.orders().filter(o=>o.status!=='REJECTED').length,0);
    }finally{await dispose(r);}
  }
});
test('unknown submission results retain one durable intent and are never automatically retried',async()=>{
  const r=await enabled();try{
    const {id,input}=await request(r);let submits=0;r.broker.submit=async()=>{submits++;throw new Error('isolated timeout');};
    assert.equal(await r.engine.confirmExecution(id,await testSize(input),now),false);
    assert.equal(r.store.orders()[0]!.status,'UNKNOWN');assert.equal(r.engine.decisionStates.get('9001')!.state,'UNKNOWN');
    await r.engine.tick(new Date(now.getTime()+3000));await r.engine.tick(new Date(now.getTime()+6000));
    assert.equal(submits,1);assert.equal(r.engine.pendingExecutions.size,0);
  }finally{await dispose(r);}
});
test('new odd-lot inventory is monitored immediately, cannot exit that day, and can size a protective sale on the next session',async()=>{
  const r=await enabled();try{
    const {id,input}=await request(r);assert.equal(await r.engine.confirmExecution(id,{...await testSize(input),shares:7},now),true);
    await r.engine.tick(new Date(now.getTime()+3000));r.market.marketPrice='28.5';
    await r.engine.tick(new Date(now.getTime()+6000));assert.equal(r.engine.pendingExecutions.size,0);
    assert.equal(r.store.orders().filter(o=>o.action==='SELL').length,0);assert.match(r.engine.decisionStates.get('9001')!.reason,/不可當沖/);
    r.engine.watch.entries=[];await r.engine.refreshAccount(new Date(now.getTime()+9000));
    assert.equal(r.engine.watch.entries[0]!.symbol,'9001');assert.equal(r.engine.watch.entries[0]!.state,'RETAINED');
    const next=new Date('2026-10-12T10:00:00+08:00');await r.engine.tick(next);
    const exitId=r.engine.nextExecutionId()!,exit=(await r.engine.executionRequest(exitId,next))!;
    assert.equal(exit.action,'SELL');assert.equal(exit.source,'PROTECTION');assert.equal(exit.account.positions[0]!.sellable,7);
    assert.equal(await r.engine.confirmExecution(exitId,await testSize(exit),next),true);
    await r.engine.tick(new Date(next.getTime()+3000));assert.equal(r.store.orders().find(o=>o.action==='SELL')!.filled,7);
  }finally{await dispose(r);}
});
test('missing exits for an unprotected holding reject a daily strategy; existing protection remains valid',()=>{
  const s=snapshot();s.account.positions=[{symbol:'9001',shares:10,sellable:10,average_price:'30',last_price:'30'}];
  const config=SettingsSchema.parse({...settings(),codex_enabled:true}),a:Analysis={...demoAnalysis(s,config,now),decisions:[]};
  assert.throws(()=>validateAnalysis(a,s,now,config),/出場條件/);
  s.existing_protection['9001']={stop_price:'29',take_profit:'33',trailing_activate:null,trailing_fraction:null};
  assert.ok(validateAnalysis(a,s,now,config));
});
test('a paused quantity turn releases the service queue for reconciliation and emergency stop cancels its later answer',async()=>{
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{entered=resolve;});
  let at=new Date(now);const service=new TradingService(':memory:','demo',()=>new ControlledMarket(),{now:()=>at,
    executionAdvisor:async request=>{entered();await gate;return testSize(request);}});
  try{
    await service.start(false);service.engine.setSettings({...service.engine.settings,codex_enabled:true,auto_execute:true,watch_min_amount:'0'});
    const snap=await service.engine.snapshot(at);await service.engine.activate(demoAnalysis(snap,service.engine.settings,at),snap,at);
    await service.engine.tick(at);const task=service.processExecutions();await began;
    assert.equal(service.sizing,true);at=new Date(now.getTime()+3000);
    await service.command('reconcile');assert.equal(service.engine.account!.asof,at.toISOString());
    const stopped=service.command('stop');assert.equal(service.engine.killed,true);await stopped;
    release();await task;assert.equal(service.store.orders().length,0);assert.equal(service.sizing,false);
  }finally{release();await service.close();}
});
test('a pause arriving during the final account refresh cannot submit a quantity already accepted by Codex',async()=>{
  const r=await enabled();try{
    const {id,input}=await request(r);let reads=0,entered!:()=>void,release!:()=>void;
    const began=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;}),read=r.broker.account.bind(r.broker);
    r.broker.account=async at=>{if(++reads===2){entered();await gate;}return read(at);};
    const confirming=r.engine.confirmExecution(id,await testSize(input),now);await began;r.engine.pauseEntries();release();
    assert.equal(await confirming,false);assert.equal(r.store.orders().length,0);
  }finally{await dispose(r);}
});
test('a slow trigger-time Codex turn freezes replay time and completes confirmation before the next event',async()=>{
  const day='2026-01-05',data=syntheticDataset(day,day);for(const p of data.points){p.open=p.high=p.low=p.close='30';p.volume_shares=1000000;}
  const clock=new ReplayClock(),frames:ReplayFrame[]=[];let release!:()=>void,entered!:()=>void,quantities=0;
  const gate=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{entered=resolve;});
  const running=runBacktest({start:day,end:day,source:'sample',strategy:'codex',end_time:'09:31'},data,SettingsSchema.parse({codex_enabled:true}),
    async s=>{const a=demoAnalysis(s,SettingsSchema.parse({mode:'demo'}),new Date(s.asof));a.decisions[0]!.limit_price='30.3';a.screening!.entry=null;return a;},new AbortController().signal,undefined,clock,f=>frames.push(f),undefined,
    async input=>{if(++quantities===1){entered();await gate;}return testSize(input);});
  await began;const at=frames.at(-1)!.at;clock.command('pause');await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(frames.at(-1)!.at,at);assert.equal(frames.at(-1)!.account.orders.length,0);
  assert.ok(frames.at(-1)!.execution_queue!.some(t=>t.state==='RUNNING'));
  release();for(let n=0;n<40&&!frames.at(-1)!.account.orders.length;n++)await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(frames.at(-1)!.at,at);assert.ok(frames.at(-1)!.account.orders.length);clock.setSpeed(0);clock.command('resume');
  const report=await running;assert.equal(report.status,'COMPLETED');assert.ok(report.metrics.execution_confirmations!>0);assert.ok(report.fills.length);
});
test('Codex replay cannot silently bypass a missing quantity advisor or its shared call budget',async()=>{
  const day='2026-01-05',data=syntheticDataset(day,day);for(const p of data.points){p.open=p.high=p.low=p.close='30';p.volume_shares=1000000;}
  const analyze=async(s:ReturnType<typeof snapshot>)=>demoAnalysis(s,SettingsSchema.parse({mode:'demo'}),new Date(s.asof));
  for(const budget of [1,10]){
    const report=await runBacktest({start:day,end:day,source:'sample',strategy:'codex',end_time:'09:12',max_codex_calls:budget},data,
      SettingsSchema.parse({codex_enabled:true}),analyze,new AbortController().signal);
    assert.equal(report.status,'PARTIAL');assert.equal(report.orders.length,0);assert.equal(report.fills.length,0);
    assert.ok(report.metrics.codex_calls<=budget);
    assert.ok(budget===1?report.limitations.some(x=>x.includes('呼叫上限包含')):report.failures!.some(f=>f.stage==='SIZING'&&f.issue.includes('禁止跳過')));
  }
});
test('complete Codex journal persists beyond the compact view and updates a streamed item without duplicate rows',()=>{
  const root=mkdtempSync(join(tmpdir(),'codex-journal-')),path=join(root,'journal.db');let store=new Store(path);
  try{
    for(let n=0;n<260;n++)store.recordAnalystEvent({id:'event-'+n,at:now.toISOString(),asof:now.toISOString(),model:'actual-model',reasoning:'high',stage:'REASONING',message:'summary '+n,details:{n}});
    store.recordAnalystEvent({id:'event-259',at:now.toISOString(),asof:now.toISOString(),model:'actual-model',reasoning:'high',stage:'REASONING',message:'complete summary',details:{n:259}});
    assert.equal(store.analystEvents().length,200);store.close();store=new Store(path);
    const full=store.analystEvents(0);assert.equal(full.length,260);assert.equal(full[0]!.message,'summary 0');assert.equal(full.at(-1)!.message,'complete summary');
    assert.deepEqual(full.at(-1)!.details,{n:259});
    assert.deepEqual(store.analystEvent('event-259')!.details,{n:259});
    const compact=compactAnalystEvent(full.at(-1)!);assert.equal(compact.has_details,true);assert.equal(compact.details,undefined);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test('realtime paper panes keep current account, conditions and Codex events even when an old replay report is loaded',()=>{
  const live={mode:'paper',account:{cash:'50000'},plan:{id:'today'},quotes:[{symbol:'9001'}],watch:{entries:[{symbol:'9001'}]}};
  const state={runtime:live,simulation_scope:'realtime',backtest_result:{asof:'2026-01-05T01:00:00Z',metrics:{final_cash:'100000'}},
    analyst_events:[{context:'live',asof:now.toISOString(),stage:'MODEL'},{context:'replay',asof:'2026-01-05T01:00:00Z',stage:'MODEL'}]} as unknown as DesktopState;
  assert.equal(workspaceRuntime(state),live);assert.equal(workspaceEvents(state).length,1);assert.equal(workspaceEvents(state)[0]!.context,'live');
});
test('inspecting a stock outside the watchlist subscribes its quotes without authorizing a trade or accumulating old inspections',async()=>{
  const r=await enabled();try{
    const subscribed:string[][]=[],read=r.broker.subscribe.bind(r.broker);
    r.broker.subscribe=async(symbols,whole)=>{subscribed.push([...symbols]);await read(symbols,whole);};
    const watch=structuredClone(r.engine.watch),plan=structuredClone(r.engine.plan);
    await r.engine.inspectSymbol('9008',now);assert.ok(subscribed.at(-1)!.includes('9008'));assert.ok(r.engine.metadata['9008']);
    await r.engine.inspectSymbol('9009',now);assert.ok(subscribed.at(-1)!.includes('9009'));assert.equal(subscribed.at(-1)!.includes('9008'),false);
    assert.deepEqual(r.engine.watch,watch);assert.deepEqual(r.engine.plan,plan);assert.equal(r.engine.pendingExecutions.size,0);assert.equal(r.store.orders().length,0);
  }finally{await dispose(r);}
});
