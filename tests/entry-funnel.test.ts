import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EntryFunnel,ENTRY_STAGES} from '../src/core/entry-funnel.js';
import {rig,now} from './helpers.js';

test('repeated scans, retries and two lots remain one signal with overlapping rejection reasons',()=>{
  const funnel=new EntryFunnel();
  for(let i=0;i<30;i++)for(const source of ['ODD','COMMON'])funnel.record('plan','9001',source,new Date(now.getTime()+i*300000),
    {stage:'COST',status:'BLOCK',code:'NET_REWARD',reason:'Insufficient net reward'});
  funnel.record('plan','9001','AI',now,{stage:'COST',status:'PASS',code:'NET_REWARD'});
  const r=funnel.report();assert.equal(r.unique_signals,1);assert.equal(r.rejections[0]!.signals,1);assert.equal(r.rejections[0]!.samples,60);
  const cost=r.stages.find(s=>s.stage==='COST')!;assert.equal(cost.blocked,1);assert.equal(cost.passed,1);assert.equal(cost.converted,0);
  assert.equal(r.stages.find(s=>s.stage==='DATA')!.unknown,1);
  funnel.record('replacement','9001','AI',now,{stage:'CANDIDATE',status:'PASS',code:'CANDIDATE'});
  assert.equal(funnel.report().unique_signals,2);
});
test('conversion requires actual earlier checks and distinguishes an absent trend rule',()=>{
  const f=new EntryFunnel();for(const stage of ENTRY_STAGES)f.record('p','9001','AI',now,{stage,status:stage==='TREND'?'NOT_REQUIRED':'PASS',code:'ACTUAL'});
  const r=f.report();assert.ok(r.stages.every(s=>s.converted===1));assert.equal(r.stages[2]!.not_required,1);assert.equal(r.stages[2]!.passed,0);
  r.signals[0]!.sources.push('mutated');assert.ok(!f.report().signals[0]!.sources.includes('mutated'));
});
test('diagnostic capacity loss is explicit and never counted as a successfully observed opportunity',()=>{
  const f=new EntryFunnel(1);for(const symbol of ['9001','9002','9002'])f.record('p',symbol,'AI',now,{stage:'CANDIDATE',status:'PASS',code:'CANDIDATE'});
  const r=f.report();assert.equal(r.complete,false);assert.equal(r.omitted_signals,1);assert.equal(r.unique_signals,1);
});
test('actual engine exposes candidate through fill checks without parsing waiting messages',async()=>{
  const r=await rig();try{
    r.engine.setSettings({...r.s,execution_sizing:'deterministic'});r.market.marketPrice='30';await r.engine.tick(now);
    await r.engine.tick(new Date(now.getTime()+1000));
    const funnel=r.engine.entryFunnel.report(),signal=funnel.signals.find(s=>s.symbol==='9001');assert.ok(signal);
    assert.equal(signal.checks.CANDIDATE?.passed,true);assert.equal(signal.checks.DATA?.passed,true);
    assert.equal(signal.checks.COST?.passed,true);assert.equal(signal.checks.RISK?.passed,true);
    assert.equal(signal.checks.SUBMITTED?.passed,true);assert.equal(signal.checks.FILLED?.passed,true);
    assert.equal(funnel.signals.filter(s=>s.symbol==='9001').length,1);
  }finally{await r.engine.close();r.store.close();}
});
