import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ThreadEvent} from '@openai/codex-sdk';
import {CodexAnalyst,CodexError,codexEnvironment,codexIssue,diagnoseCodexFailure,type AnalystEvent,type Runner} from '../src/core/codex.js';
import {codexNetworkContext,shouldHaltCodex} from '../src/core/codex-failure.js';
import {CodexLogin} from '../src/desktop/codex-login.js';
import {SettingsSchema} from '../src/core/models.js';
import {TradingService} from '../src/core/service.js';
import {demoAnalysis} from '../src/core/strategy.js';
import {runBacktest,type ReplayFrame} from '../src/core/backtest.js';
import {syntheticDataset} from '../src/core/backtest-data.js';
import {appendReplayActivity} from '../src/core/backtest-controller.js';
import {ControlledMarket,now,rig,snapshot,testSize} from './helpers.js';

test('connection diagnostics distinguish transport and account failures without exposing their raw cause',()=>{
  const fixtures=[['ENOTFOUND private-host','NETWORK','DNS_FAILURE'],['invalid peer certificate private-path','NETWORK','TLS_CERTIFICATE'],
    ['HTTP 407 Proxy Authentication Required','NETWORK','PROXY_AUTH'],['ECONNRESET private-host','NETWORK','CONNECTION_RESET'],
    ['stream disconnected before completion','NETWORK','STREAM_INTERRUPTED'],['response status 503','NETWORK','HTTP_SERVER_ERROR'],
    ['HTTP status 401 Unauthorized','AUTH','AUTH_REQUIRED'],['HTTP 403 Forbidden','ACCESS','HTTP_403'],
    ['insufficient_quota','QUOTA','QUOTA_EXCEEDED'],['429 Too many requests','RATE_LIMIT','RATE_LIMIT'],
    ['model not available','MODEL','MODEL_UNAVAILABLE']] as const;
  for(const [message,kind,code]of fixtures){
    const error=new Error('SDK failed',{cause:new Error(message+' PRIVATE_TOKEN https://secret.invalid/?token=PRIVATE_TOKEN')});
    const diagnostic=diagnoseCodexFailure(error);assert.equal(diagnostic.kind,kind);assert.equal(diagnostic.code,code);
    assert.equal(shouldHaltCodex(error),true);assert.ok(!JSON.stringify(diagnostic).includes('PRIVATE'));
    assert.ok(!codexIssue(error).includes('PRIVATE'));assert.ok(!codexIssue(error).includes('secret.invalid'));
  }
  for(const amount of [401,407,429])assert.equal(diagnoseCodexFailure(new Error(`Invalid quantity ${amount}`)).kind,'OTHER');
  assert.equal(diagnoseCodexFailure(new SyntaxError('Unexpected TLS PRIVATE_TOKEN in JSON')).code,'INVALID_OUTPUT');
  assert.equal(shouldHaltCodex(new CodexError('使用者停止','CANCELLED')),false);
});
test('explicit proxy and custom CA settings survive the Codex environment filter, including case variants',()=>{
  const env=codexEnvironment({PATH:'binary-path',http_proxy:'http://proxy-user:private@proxy.invalid',ALL_PROXY:'socks5://private@proxy.invalid',
    no_proxy:'localhost',Codex_Ca_Certificate:'private-ca-path',https_proxy:'lower',HTTPS_PROXY:'explicit',
    SJ_API_KEY:'broker-key',SJ_SECRET_KEY:'broker-secret',CA_CERT_PATH:'broker-ca',CA_PASSWORD:'broker-password'},'isolated-profile');
  assert.equal(env.HTTP_PROXY,'http://proxy-user:private@proxy.invalid');assert.equal(env.HTTPS_PROXY,'explicit');
  assert.equal(env.ALL_PROXY,'socks5://private@proxy.invalid');assert.equal(env.NO_PROXY,'localhost');assert.equal(env.CODEX_CA_CERTIFICATE,'private-ca-path');
  assert.equal(env.CODEX_HOME,'isolated-profile');assert.ok(!Object.keys(env).some(k=>k.startsWith('SJ_')||k==='CA_PASSWORD'||k==='CA_CERT_PATH'));
  assert.deepEqual(codexNetworkContext(env),{proxy_configured:true,custom_ca_configured:true});
  assert.deepEqual(codexNetworkContext({}),{proxy_configured:false,custom_ca_configured:false});
});
test('an SDK error emits one safe diagnostic and preserves its type across the analyst boundary',async()=>{
  const events:AnalystEvent[]=[];
  const runner:Runner=async()=>({events:(async function*(){yield {type:'turn.failed',error:{message:'ECONNREFUSED http://private-host?token=PRIVATE_TOKEN'}} as ThreadEvent;})()});
  const analyst=new CodexAnalyst(SettingsSchema.parse({execution_sizing:'codex',codex_enabled:true}),'/unused',runner,undefined,event=>events.push(event));
  await assert.rejects(analyst.analyze(snapshot()),error=>error instanceof CodexError&&error.kind==='NETWORK'&&error.diagnostic.code==='CONNECTION_REFUSED');
  const failures=events.filter(e=>e.stage==='FAILED');assert.equal(failures.length,1);
  assert.deepEqual(failures[0]!.details,{kind:'NETWORK',code:'CONNECTION_REFUSED',...codexNetworkContext(process.env)});
  assert.ok(!JSON.stringify(failures).includes('PRIVATE_TOKEN'));assert.ok(!JSON.stringify(failures).includes('private-host'));
});
test('the replay journal combines two descriptions of one failed turn while retaining the diagnostic and actual model',()=>{
  const at=now.toISOString(),events:AnalystEvent[]=[{id:'run:failure',run_id:'run',at,asof:at,stage:'FAILED',message:'Codex 連線被重設',
    model:'actual-model',reasoning:'low',purpose:'STRATEGY',details:{kind:'NETWORK',code:'CONNECTION_RESET'}}];
  appendReplayActivity(events,{at,stage:'FAILED',message:'2026-10-08 10:00 · ANALYSIS · Codex 連線被重設'});
  assert.equal(events.length,1);assert.equal(events[0]!.id,'run:failure');assert.equal(events[0]!.model,'actual-model');
  assert.deepEqual(events[0]!.details,{kind:'NETWORK',code:'CONNECTION_RESET'});assert.match(events[0]!.message,/ANALYSIS/);
  appendReplayActivity(events,{at,stage:'HALTED',message:'本次回測已停止'});assert.equal(events.length,2);
  appendReplayActivity(events,{at:new Date(now.getTime()+300000).toISOString(),stage:'FAILED',message:'資料未通過核對'});assert.equal(events.length,3);
});
test('a real analyst timeout is distinct from a caller cancellation',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  for(const cancelled of [false,true]){
    let entered!:()=>void;const began=new Promise<void>(resolve=>{entered=resolve;});
    const runner:Runner=async(_prompt,{signal})=>{entered();await new Promise<void>((_resolve,reject)=>{
      signal.addEventListener('abort',()=>reject(new Error('AbortError PRIVATE_TOKEN')),{once:true});
    });throw new Error('unreachable');};
    const events:AnalystEvent[]=[],controller=new AbortController(),analyst=new CodexAnalyst(SettingsSchema.parse({execution_sizing:'codex',codex_enabled:true,codex_timeout_seconds:30}),'/unused',runner,undefined,e=>events.push(e));
    const pending=analyst.analyze(snapshot(),controller.signal);await began;
    if(cancelled)controller.abort();else t.mock.timers.tick(30000);
    await assert.rejects(pending,error=>error instanceof CodexError&&error.kind===(cancelled?'CANCELLED':'TIMEOUT')&&shouldHaltCodex(error)===!cancelled);
    assert.equal((events.at(-1)!.details as {code:string}).code,cancelled?'CODEX_CANCELLED':'CODEX_TIMEOUT');
    assert.ok(!JSON.stringify(events.at(-1)).includes('PRIVATE_TOKEN'));
  }
});
test('the connection probe retains TLS diagnosis and clears its failed status only after a valid completed response',async()=>{
  const root=mkdtempSync(join(tmpdir(),'codex-network-probe-'));let broken=true;
  const auth=new CodexLogin(root,async()=>undefined,async()=>undefined,{sourceProfile:join(root,'empty'),run:async()=>({}),probe:async()=>(async function*(){
    if(broken){yield {type:'turn.failed',error:{message:'TLS unknown issuer PRIVATE_TOKEN'}} as ThreadEvent;return;}
    yield {type:'item.completed',item:{type:'agent_message',id:'test',text:'{"ok":true}'}} as ThreadEvent;
    yield {type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1,cache_write_input_tokens:0,reasoning_output_tokens:0}} as ThreadEvent;
  })()});
  try{await assert.rejects(auth.test(SettingsSchema.parse({})),error=>error instanceof CodexError&&error.diagnostic.code==='TLS_CERTIFICATE');
    assert.equal(auth.status.test_state,'failed');assert.match(auth.status.message,/TLS/);assert.ok(!auth.status.message.includes('PRIVATE_TOKEN'));
    broken=false;const message=await auth.test(SettingsSchema.parse({codex_model:'gpt-6.1-sol',codex_reasoning:'low'}));
    assert.equal(auth.status.test_state,'connected');assert.equal(message,'Codex 連線測試成功');assert.equal(auth.status.message,message);
    assert.equal(auth.status.model,'gpt-6.1-sol');assert.equal(auth.status.reasoning,'low');
  }finally{auth.close();rmSync(root,{recursive:true,force:true});}
});
test('a sizing outage blocks automatic model calls while account reconciliation continues, then recovery still requires fresh sizing',async()=>{
  let at=new Date(now),calls=0;const service=new TradingService(':memory:','demo',()=>new ControlledMarket(),{now:()=>at,
    executionAdvisor:async request=>{if(++calls===1)throw new Error('ECONNRESET PRIVATE_TOKEN');return testSize(request);}});
  try{
    await service.start(false);service.engine.setSettings({...service.engine.settings,execution_sizing:'codex',codex_enabled:true,auto_execute:true,watch_min_amount:'0'});
    const snap=await service.engine.snapshot(at);await service.engine.activate(demoAnalysis(snap,service.engine.settings,at),snap,at);
    await service.engine.tick(at);await service.processExecutions();assert.equal(calls,1);assert.match(service.engine.advisorIssue,/連線被重設/);
    assert.equal(service.engine.pendingExecutions.size,0);assert.equal(service.store.orders().length,0);
    at=new Date(now.getTime()+(service.engine.settings.cooldown_seconds+1)*1000);
    await service.command('reconcile');await service.engine.tick(at);await service.processExecutions();
    assert.equal(calls,1);assert.equal(service.engine.account!.asof,at.toISOString());assert.equal(service.store.orders().length,0);
    service.clearCodexFailure();assert.equal(service.analystEvents.at(-1)!.stage,'RECOVERED');
    await service.engine.tick(at);await service.processExecutions();assert.equal(calls,2);assert.ok(service.store.orders().length);
    assert.ok(!JSON.stringify(service.analystEvents.filter(e=>e.stage==='FAILED')).includes('PRIVATE_TOKEN'));
  }finally{await service.close();}
});
test('an outage invalidates an in-flight sizing answer; clearing it cannot undo pause, stop or a failed daily plan',async()=>{
  const r=await rig();try{
    r.engine.setSettings({...r.s,codex_enabled:true});await r.engine.tick(now);
    const id=r.engine.nextExecutionId()!,request=(await r.engine.executionRequest(id,now))!,advice=await testSize(request);
    r.engine.setAdvisorIssue('Codex 回應串流中斷');assert.equal(r.engine.pendingExecutions.size,0);
    assert.equal(await r.engine.confirmExecution(id,advice,now),false);assert.equal(r.store.orders().length,0);
    r.engine.pauseEntries();r.engine.kill();r.engine.entryBlocked=true;r.engine.setAdvisorIssue('');
    assert.equal(r.engine.pausedEntries,true);assert.equal(r.engine.killed,true);assert.equal(r.engine.entryBlocked,true);
    await r.engine.tick(now);assert.equal(r.engine.pendingExecutions.size,0);assert.equal(r.store.orders().length,0);
  }finally{await r.engine.close();r.store.close();}
});
test('transport, authentication and timeout failures end historical replay at the first failed strategy with a redacted checkpoint',async()=>{
  const day='2026-01-05';
  for(const error of [new Error('ENOTFOUND PRIVATE_TOKEN'),new Error('401 Unauthorized PRIVATE_TOKEN'),new CodexError('Codex 回應逾時','TIMEOUT')]){
    const data=syntheticDataset(day,'2026-01-06'),frames:ReplayFrame[]=[];let calls=0;
    const report=await runBacktest({start:day,end:'2026-01-06',source:'sample',strategy:'codex'},data,SettingsSchema.parse({execution_sizing:'codex',codex_enabled:true}),
      async()=>{calls++;throw error;},new AbortController().signal,undefined,undefined,f=>frames.push(f),undefined,testSize);
    assert.equal(calls,1);assert.equal(report.status,'PARTIAL');assert.equal(report.quality.halt_reason,'CODEX_'+diagnoseCodexFailure(error).kind);
    assert.equal(report.asof,report.quality.halted_at);assert.equal(report.daily_equity.at(-1)!.complete,false);
    assert.equal(report.orders.length,0);assert.equal(report.fills.length,0);assert.equal(report.metrics.codex_calls,1);
    assert.ok(frames.every(f=>f.at<=report.asof));assert.ok(report.failures![0]!.diagnostic);assert.ok(!JSON.stringify(report.failures).includes('PRIVATE_TOKEN'));
  }
});
test('a sizing transport failure never skips confirmation or proceeds to another historical model request',async()=>{
  const day='2026-01-05',data=syntheticDataset(day,'2026-01-06'),config=SettingsSchema.parse({execution_sizing:'codex',codex_enabled:true});let sizes=0;
  for(const p of data.points){p.open=p.high=p.low=p.close='30';p.volume_shares=1000000;}
  const report=await runBacktest({start:day,end:'2026-01-06',source:'sample',strategy:'codex'},data,config,
    async s=>demoAnalysis(s,config,new Date(s.asof)),new AbortController().signal,undefined,undefined,undefined,undefined,
    async()=>{sizes++;throw new Error('stream disconnected PRIVATE_TOKEN');});
  assert.equal(sizes,1);assert.equal(report.status,'PARTIAL');assert.equal(report.quality.halt_reason,'CODEX_NETWORK');
  assert.equal(report.orders.length,0);assert.equal(report.fills.length,0);assert.deepEqual(report.final_frame!.execution_queue,[]);
  assert.equal(report.failures!.at(-1)!.diagnostic!.code,'STREAM_INTERRUPTED');
});
