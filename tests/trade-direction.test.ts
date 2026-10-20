import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {rig,now,snapshot,settings,testSize} from './helpers.js';
import {SettingsSchema,storedSettings,type Analysis} from '../src/core/models.js';
import {demoAnalysis,validateAnalysis} from '../src/core/strategy.js';
import {programAnalysis} from '../src/core/program-strategy.js';
import {analysisPrompt} from '../src/core/codex.js';
import {DesktopSettings} from '../src/desktop/settings.js';
import {runBacktest} from '../src/core/backtest.js';
import {syntheticDataset} from '../src/core/backtest-data.js';

test('direction preference defaults to auto, persists across desktop modes, and never grants execution',()=>{
  assert.equal(storedSettings({}).trade_direction,'auto');
  assert.throws(()=>SettingsSchema.parse({trade_direction:'sell_everything'}));
  const root=mkdtempSync(join(tmpdir(),'trade-direction-'));
  try{
    const s=SettingsSchema.parse({trade_direction:'reduce_only',auto_execute:true}),prefs=new DesktopSettings(root);
    prefs.save(s);
    const restored=new DesktopSettings(root).apply(SettingsSchema.parse({}),'live',s.base_url);
    assert.equal(restored.trade_direction,'reduce_only');assert.equal(restored.auto_execute,false);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('reduce-only prompts and deterministic strategies grant no entry authority; contradictory model output is refused',()=>{
  const snap=snapshot(),s=SettingsSchema.parse({...settings(),trade_direction:'reduce_only'});
  snap.hard_limits.trade_direction='reduce_only';
  for(const a of [programAnalysis(snap,s),demoAnalysis(snap,s,now)]){
    assert.equal(a.stance,'REDUCE');assert.ok(!a.screening?.entry);assert.ok(!a.decisions.some(d=>d.action==='BUY'));
    assert.ok(validateAnalysis(a,snap,now,s));
  }
  const buy=demoAnalysis(snap,settings(),now);
  assert.throws(()=>validateAnalysis(buy,snap,now,s),/僅減碼/);
  assert.throws(()=>validateAnalysis({...buy,stance:'REDUCE',decisions:[]},snap,now,s),/僅減碼/);
  const normalized=validateAnalysis({...buy,stance:'HOLD_ONLY',decisions:[]},snap,now,settings());
  assert.equal(normalized.analysis.screening!.entry,null);
  assert.match(analysisPrompt(snap),/REDUCE 不是立刻清倉命令/);
});
test('both non-buying stances block malformed restored BUY decisions at monitoring and final submission',async()=>{
  for(const stance of ['REDUCE','HOLD_ONLY'] as const){
    const r=await rig();try{
      r.engine.plan!.analysis.stance=stance;
      await r.engine.tick(now);
      assert.equal(r.store.orders().length,0);
      assert.match(r.engine.decisionStates.get('9001')!.reason,/禁止新增買進/);
      const order=r.engine.newOrder('9001','BUY',5,'30.05','ODD',now,r.engine.plan!.id,'ENTRY');
      assert.equal(await r.engine.submit(order,now,r.engine.plan!.analysis.decisions[0]!.smart!),false);
      assert.equal(r.store.orders().length,0);
    }finally{await r.engine.close();r.store.close();}
  }
});
test('changing to reduce-only invalidates an in-flight quantity answer and blocks the old BUY plan',async()=>{
  const r=await rig();try{
    r.engine.setSettings({...r.engine.settings,codex_enabled:true});await r.engine.tick(now);
    const id=r.engine.nextExecutionId();assert.ok(id);
    const input=await r.engine.executionRequest(id,now);assert.ok(input);
    r.engine.setSettings({...r.engine.settings,trade_direction:'reduce_only'});
    assert.equal(r.engine.pendingExecutions.size,0);
    assert.equal(await r.engine.confirmExecution(id,await testSize(input),now),false);
    await r.engine.tick(new Date(now.getTime()+3000));assert.equal(r.store.orders().length,0);
    assert.match(r.engine.decisionStates.get('9001')!.reason,/僅減碼/);
  }finally{await r.engine.close();r.store.close();}
});
test('reduce-only cancels a local resting entry and retains the confirmed cancellation record',async()=>{
  const r=await rig();try{
    const order=r.engine.newOrder('9001','BUY',5,'29.5','ODD',now,r.engine.plan!.id,'ENTRY');
    assert.equal(await r.engine.submit(order,now,r.engine.plan!.analysis.decisions[0]!.smart!),true);
    assert.equal(r.store.orders(true).length,1);
    r.engine.setSettings({...r.engine.settings,trade_direction:'reduce_only'});
    await r.engine.tick(new Date(now.getTime()+3000));
    assert.equal(r.store.orders(true).length,0);
    assert.equal(r.store.order(order.local_id)!.status,'CANCELLED');
  }finally{await r.engine.close();r.store.close();}
});
test('a reduce strategy sells only its explicit quantity once; remaining holdings retain deterministic protection',async()=>{
  const r=await rig();try{
    r.market.depth=100;await r.engine.tick(now);await r.engine.tick(new Date(now.getTime()+3000));
    assert.equal(r.engine.account!.positions[0]!.shares,30);
    const next=new Date('2026-10-12T10:00:00+08:00');await r.engine.tick(next,false,false);
    r.engine.setSettings({...r.engine.settings,trade_direction:'reduce_only'});
    const snap=await r.engine.snapshot(next);
    const analysis:Analysis={snapshot_id:snap.snapshot_id,expires_at:new Date(next.getTime()+3600000).toISOString(),
      stance:'REDUCE',candidates:[],screening:null,summary:'合成資料：依條件減碼 10 股',decisions:[{
        symbol:'9001',action:'SELL',shares:10,limit_price:'29.9',entry_when:'IMMEDIATE',trigger_price:'0',smart:null,reason:'合成資料減碼'}]};
    await r.engine.activate(analysis,snap,next);await r.engine.tick(next);
    await r.engine.tick(new Date(next.getTime()+3000));await r.engine.tick(new Date(next.getTime()+6000));
    assert.equal(r.store.orders().filter(o=>o.purpose==='EXIT').length,1);
    assert.equal(r.engine.account!.positions[0]!.shares,20);
    assert.equal(r.store.protections().length,1);
    const expired=new Date(next.getTime()+3603000);r.market.marketPrice='28.5';await r.engine.tick(expired);
    assert.equal(r.store.orders().filter(o=>o.purpose==='PROTECTION').length,1);
    assert.equal(r.store.orders().find(o=>o.purpose==='PROTECTION')!.shares,20);
  }finally{await r.engine.close();r.store.close();}
});
test('replay records its direction and a reduce-only program run cannot buy',async()=>{
  const day='2026-01-05',s=SettingsSchema.parse({trade_direction:'reduce_only'});
  const report=await runBacktest({start:day,end:day,source:'sample',strategy:'rules'},syntheticDataset(day,day),s,
    undefined,new AbortController().signal);
  assert.equal(report.settings.trade_direction,'reduce_only');
  assert.ok(!report.orders.some(o=>o.action==='BUY'));assert.equal(report.status,'COMPLETED');
});
