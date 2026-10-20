import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ThreadEvent} from '@openai/codex-sdk';
import {CodexAnalyst,CodexError,codexIssue,diagnoseCodexFailure,shouldHaltCodex,type AnalystEvent,type Runner} from '../src/core/codex.js';
import {CodexLogin} from '../src/desktop/codex-login.js';
import {SettingsSchema} from '../src/core/models.js';
import {TradingService} from '../src/core/service.js';
import {demoAnalysis} from '../src/core/strategy.js';
import {runBacktest} from '../src/core/backtest.js';
import {syntheticDataset} from '../src/core/backtest-data.js';
import {ControlledMarket,now,snapshot} from './helpers.js';

const settings=SettingsSchema.parse({execution_sizing:'codex',codex_enabled:true});
const secret='PRIVATE_TOKEN https://private.invalid/?token=PRIVATE_TOKEN C:\\private\\auth.json';
const stream=(events:ThreadEvent[]):Runner=>async()=>({events:(async function*(){yield* events;})()});
const completed={type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:1,reasoning_output_tokens:0}} as ThreadEvent;

test('actual SDK process-exit wrappers retain an allowlisted status without exporting stderr or confusing an account failure',()=>{
  for(const code of [1,3221225477]){
    const error=new Error(`Codex Exec exited with code ${code}: native failure ${secret}`);
    assert.deepEqual(diagnoseCodexFailure(error),{kind:'RUNTIME',code:'PROCESS_EXIT',exit_code:code});
    assert.equal(shouldHaltCodex(error),true);assert.match(codexIssue(error),new RegExp(String(code)));
    assert.ok(!codexIssue(error).includes('PRIVATE'));assert.ok(!codexIssue(error).includes('登入'));
  }
  assert.deepEqual(diagnoseCodexFailure(new Error(`Codex Exec exited with signal SIGSEGV: ${secret}`)),
    {kind:'RUNTIME',code:'PROCESS_SIGNAL',exit_signal:'SIGSEGV'});
  assert.equal(diagnoseCodexFailure(new Error(`Codex Exec exited with code 1: HTTP status 401 Unauthorized ${secret}`)).kind,'AUTH');
  assert.equal(diagnoseCodexFailure(new Error(`Failed to parse item: ${secret}`,{cause:new SyntaxError('TLS')})).code,'STREAM_PROTOCOL');
});

for(const [event,code]of [
  [{type:'turn.failed',error:{message:`Unexpected internal failure ${secret}`}},'TURN_FAILED'],
  [{type:'error',message:`Unexpected internal failure ${secret}`},'STREAM_ERROR'],
  [{type:'item.completed',item:{type:'error',id:'error',message:`Unexpected internal failure ${secret}`}},'ITEM_ERROR'],
] as const){
  test(`a terminal ${event.type} preserves its failure source and stops instead of showing the generic login/model hint`,async()=>{
    const journal:AnalystEvent[]=[];
    const analyst=new CodexAnalyst(settings,'/unused',stream([event as ThreadEvent]),undefined,e=>journal.push(e));
    await assert.rejects(analyst.analyze(snapshot()),error=>error instanceof CodexError&&error.kind==='RUNTIME'&&error.diagnostic.code===code&&shouldHaltCodex(error));
    assert.equal(journal.filter(e=>e.stage==='FAILED').length,1);
    assert.ok(!JSON.stringify(journal).includes('PRIVATE'));assert.ok(!journal.at(-1)!.message.includes('登入與模型狀態'));
    assert.equal(journal.some(e=>e.stage==='DECISION'),false);
  });
}

test('even a valid JSON answer is rejected when the stream ends before completion; an empty completed turn also fails closed',async()=>{
  const result=demoAnalysis(snapshot(),settings,now);
  const answer={type:'item.completed',item:{type:'agent_message',id:'answer',text:JSON.stringify(result)}} as ThreadEvent;
  for(const [events,kind,code]of [[[answer],'NETWORK','STREAM_INTERRUPTED'],[[completed],'RUNTIME','EMPTY_OUTPUT']] as const){
    const analyst=new CodexAnalyst(settings,'/unused',stream([...events]));
    await assert.rejects(analyst.analyze(snapshot()),e=>e instanceof CodexError&&e.kind===kind&&e.diagnostic.code===code&&shouldHaltCodex(e));
  }
});

test('unclassified SDK exceptions and rejected tools remain runtime faults while malformed model JSON stays a validation failure',async()=>{
  const broken:Runner=async()=>{throw new Error(`Unexpected execution error ${secret}`);};
  const analyst=new CodexAnalyst(settings,'/unused',broken);
  await assert.rejects(analyst.analyze(snapshot()),e=>e instanceof CodexError&&e.diagnostic.code==='SDK_FAILURE'&&!e.message.includes('PRIVATE'));
  const tool={type:'item.started',item:{id:'tool',type:'command_execution',command:secret,aggregated_output:'',status:'in_progress'}} as ThreadEvent;
  await assert.rejects(new CodexAnalyst(settings,'/unused',stream([tool])).analyze(snapshot()),e=>e instanceof CodexError&&e.diagnostic.code==='TOOL_REJECTED'&&e.kind==='RUNTIME');
  const bad={type:'item.completed',item:{id:'bad',type:'agent_message',text:'not valid JSON'}} as ThreadEvent;
  await assert.rejects(new CodexAnalyst(settings,'/unused',stream([bad,completed])).analyze(snapshot()),e=>e instanceof CodexError&&e.diagnostic.code==='INVALID_OUTPUT'&&e.kind==='OTHER');
});

test('a caller cancellation at stream completion cannot publish an otherwise valid strategy',async()=>{
  const controller=new AbortController(),journal:AnalystEvent[]=[];
  const result=demoAnalysis(snapshot(),settings,now);
  const runner:Runner=async()=>({events:(async function*(){
    yield {type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(result)}} as ThreadEvent;
    yield completed;controller.abort();
  })()});
  const analyst=new CodexAnalyst(settings,'/unused',runner,undefined,e=>journal.push(e));
  await assert.rejects(analyst.analyze(snapshot(),controller.signal),e=>e instanceof CodexError&&e.kind==='CANCELLED');
  assert.equal(journal.some(e=>e.stage==='DECISION'),false);
});

test('connection tests retain unknown terminal/early-stream errors and recover only on a fresh completed response',async()=>{
  const root=mkdtempSync(join(tmpdir(),'codex-incomplete-probe-'));
  let events:ThreadEvent[]=[{type:'turn.failed',error:{message:`Unexpected internal failure ${secret}`}} as ThreadEvent];
  const auth=new CodexLogin(root,async()=>undefined,async()=>undefined,{sourceProfile:join(root,'empty'),run:async()=>({}),probe:async()=>stream(events)('',{signal:new AbortController().signal,outputSchema:{}}).then(t=>t.events)});
  try{
    await assert.rejects(auth.test(settings),e=>e instanceof CodexError&&e.diagnostic.code==='TURN_FAILED');
    assert.equal(auth.status.test_state,'failed');assert.ok(!auth.status.message.includes('PRIVATE'));
    events=[{type:'item.completed',item:{id:'ok',type:'agent_message',text:'{"ok":true}'}} as ThreadEvent];
    await assert.rejects(auth.test(settings),e=>e instanceof CodexError&&e.diagnostic.code==='STREAM_INTERRUPTED');
    assert.equal(auth.status.test_state,'failed');events.push(completed);
    await auth.test(settings);assert.equal(auth.status.test_state,'connected');
  }finally{auth.close();rmSync(root,{recursive:true,force:true});}
});

test('a native sizing process exit ends replay without placing orders or continuing later schedule/comparison requests',async()=>{
  const data=syntheticDataset('2026-01-05','2026-01-06');let sizes=0;
  for(const p of data.points){p.open=p.high=p.low=p.close='30';p.volume_shares=1000000;}
  const report=await runBacktest({start:'2026-01-05',end:'2026-01-06',source:'sample',strategy:'codex'},data,settings,
    async s=>demoAnalysis(s,settings,new Date(s.asof)),new AbortController().signal,undefined,undefined,undefined,undefined,
    async()=>{sizes++;throw new Error(`Codex Exec exited with code 1: unexpected native failure ${secret}`);});
  assert.equal(sizes,1);assert.equal(report.status,'PARTIAL');assert.equal(report.quality.halt_reason,'CODEX_RUNTIME');
  assert.equal(report.failures!.at(-1)!.diagnostic!.code,'PROCESS_EXIT');assert.equal(report.orders.length,0);assert.equal(report.fills.length,0);
  assert.ok(!JSON.stringify(report.failures).includes('PRIVATE'));
});

test('a native runtime fault blocks repeated realtime sizing calls while account reconciliation continues',async()=>{
  let at=new Date(now),calls=0;
  const service=new TradingService(':memory:','demo',()=>new ControlledMarket(),{now:()=>at,executionAdvisor:async()=>{
    calls++;throw new Error(`Codex Exec exited with code 1: unexpected native failure ${secret}`);
  }});
  try{
    await service.start(false);service.engine.setSettings({...service.engine.settings,execution_sizing:'codex',codex_enabled:true,auto_execute:true,watch_min_amount:'0'});
    const snap=await service.engine.snapshot(at);await service.engine.activate(demoAnalysis(snap,service.engine.settings,at),snap,at);
    await service.engine.tick(at);await service.processExecutions();
    assert.equal(calls,1);assert.equal(service.store.orders().length,0);assert.ok(service.engine.advisorIssue);
    at=new Date(at.getTime()+300000);await service.command('reconcile');await service.engine.tick(at);await service.processExecutions();
    assert.equal(calls,1);assert.equal(service.engine.account!.asof,at.toISOString());
  }finally{await service.close();}
});
