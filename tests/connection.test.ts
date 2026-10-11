import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import type { ThreadEvent } from '@openai/codex-sdk';
import { SettingsSchema, storedSettings, twDay, type Settings } from '../src/core/models.js';
import { Store } from '../src/core/store.js';
import { TradingService } from '../src/core/service.js';
import { ShioajiHttpBroker } from '../src/broker/http.js';
import { BrokerError, BrokerHealthSchema, marketReady } from '../src/broker/health.js';
import { DesktopSettings } from '../src/desktop/settings.js';
import { NativeConnection, ConnectionInputSchema } from '../src/desktop/credentials.js';
import { CodexLogin, loginUrl } from '../src/desktop/codex-login.js';
import { codexOutputSchema, codexIssue, CodexAnalyst, type Runner } from '../src/core/codex.js';
import { shioajiDataset } from '../src/core/backtest-source.js';
import { runBacktest, BacktestRequestSchema } from '../src/core/backtest.js';
import { syntheticDataset } from '../src/core/backtest-data.js';
import { snapshot } from './helpers.js';

async function until(predicate:()=>boolean, timeout=4000):Promise<void>{
  const deadline=Date.now()+timeout;
  while(!predicate()){if(Date.now()>deadline)throw new Error('Isolated condition timed out');await new Promise(r=>setTimeout(r,20));}
}
// Every response is isolated. Account/data errors never cause a real brokerage request.
class ConnectionFixture {
  paths:string[]=[];balanceFails=false;oldDate=false;ca=false;settlements:{date:string;amount:number;T:number}[]=[];
  fetch:typeof fetch=async(input,init)=>{
    const path=new URL(String(input)).pathname;this.paths.push(path);
    if(path==='/api/v1/info')return Response.json({simulation:false,version:'1.7.7'});
    if(path==='/api/v1/health')return Response.json({status:'degraded',session_recovering:false,token_stale:false,
      token_expires_in_seconds:3600,ca_expired:!this.ca,ca_expires_in_days:this.ca?30:0});
    if(path==='/api/v1/auth/accounts')return Response.json([{account_type:'S',broker_id:'TEST',account_id:'SYNTHETIC',signed:true}]);
    if(path==='/api/v1/stream/data')return new Response(new ReadableStream<Uint8Array>({start(controller){
      controller.enqueue(new TextEncoder().encode('event: heartbeat\ndata: {}\n\n'));
      init?.signal?.addEventListener('abort',()=>controller.close(),{once:true});
    }}),{headers:{'Content-Type':'text/event-stream'}});
    if(path==='/api/v1/auth/subscribe_trade')return Response.json({subscribe_trade:true});
    if(path==='/api/v1/order/trades')return Response.json([]);
    if(path==='/api/v1/portfolio/account_balance')return this.balanceFails?Response.json({error:'NEVER_EXPOSE_ACCOUNT_OR_SECRET'},{status:503}):
      Response.json({acc_balance:100000,date:this.oldDate?'2026-01-01':twDay(new Date()),errmsg:''});
    if(path==='/api/v1/portfolio/settlements')return Response.json(this.settlements);
    if(path==='/api/v1/portfolio/position_unit')return Response.json([]);
    if(path==='/api/v1/order/trade_cache_health')return Response.json({state:'Healthy',reasons:[]});
    throw new Error('Isolated endpoint unavailable: '+path);
  };
}

test('healthy and degraded market sessions work without CA, while recovery and expired tokens stay blocked',()=>{
  const health=(extra:object)=>BrokerHealthSchema.parse({status:'degraded',...extra});
  assert.equal(marketReady(health({ca_expired:true})),true);
  assert.equal(marketReady(health({status:'healthy'})),true);
  for(const extra of [{session_recovering:true},{token_stale:true},{token_expires_in_seconds:0},{status:'unhealthy'}])assert.equal(marketReady(health(extra)),false);
});
test('paper login with default settings and no CA never queries personal accounts, portfolios or trade reports',async()=>{
  const fixture=new ConnectionFixture();fixture.balanceFails=true;
  const service=new TradingService(':memory:','paper',(store,s)=>new ShioajiHttpBroker(store,s,false,fixture.fetch));
  try{
    await service.start(false);assert.equal(service.engine.connected,true);assert.equal(service.engine.account?.complete,true);
    assert.equal(service.engine.account?.cash,'100000');assert.equal(service.engine.settings.auto_execute,false);
    assert.ok(!fixture.paths.some(p=>/\/auth\/|\/portfolio\/|\/order\/|openapi/.test(p)));
  }finally{await service.close();}
});
test('failed first account read retains market login and the monitor automatically recovers without manual reconnect',async()=>{
  const fixture=new ConnectionFixture();fixture.balanceFails=true;
  const service=new TradingService(':memory:','live',(store,s,session)=>new ShioajiHttpBroker(store,s,true,fixture.fetch,session));
  try{
    await service.saveSettings({...service.engine.settings,auto_watchlist:false,monitor_interval_seconds:1});
    await service.start(true);
    assert.equal(service.engine.connected,true);assert.equal(service.engine.account?.complete,false);
    assert.match(service.engine.dataIssue,/交割戶餘額.*HTTP 503/);
    assert.ok(!service.store.logs().join('').includes('NEVER_EXPOSE_ACCOUNT_OR_SECRET'));
    assert.ok(!service.liveReadiness().issues.some(x=>/手續費|符號|請先連接 Shioaji/.test(x)));
    assert.equal(service.liveAuthorized,false);fixture.balanceFails=false;
    await until(()=>service.engine.account?.complete===true);
    assert.equal(service.engine.dataIssue,'');assert.equal(service.engine.account?.cash,'100000');
    assert.equal(service.liveAuthorized,false);
  }finally{await service.close();}
});
test('outdated bank data does not disconnect a signed-in account or authorize real orders',async()=>{
  const fixture=new ConnectionFixture();fixture.oldDate=true;fixture.ca=true;
  const service=new TradingService(':memory:','live',(store,s,session)=>new ShioajiHttpBroker(store,s,true,fixture.fetch,session));
  try{
    await service.start(false);assert.equal(service.engine.connected,true);
    assert.match(service.liveReadiness().account,/TEST/);assert.equal(service.engine.account?.complete,false);
    await assert.rejects(service.activateLive(),/日期尚未更新/);
    assert.equal(service.liveAuthorized,false);assert.ok(!fixture.paths.some(p=>/place_order|cancel_order/.test(p)));
  }finally{await service.close();}
});
test('either sign of outstanding settlements is reserved automatically without relying on unreceived credits',async()=>{
  const fixture=new ConnectionFixture();fixture.ca=true;fixture.settlements=[
    {date:twDay(new Date()),amount:1200,T:0},{date:twDay(new Date()),amount:-3500,T:1},{date:twDay(new Date()),amount:0,T:2}];
  const service=new TradingService(':memory:','live',(store,s,session)=>new ShioajiHttpBroker(store,s,true,fixture.fetch,session));
  try{
    await service.start(false);await service.engine.refreshAccount(new Date());
    assert.equal(service.engine.account?.complete,true);assert.equal(service.engine.account?.settlement_debits,'4700');
    assert.equal(service.engine.account?.settlement_credits,'0');assert.ok(service.liveReadiness().ready);
    assert.equal(service.engine.settings.fee_rate,'0.001425');assert.equal(service.engine.settings.minimum_fee,'20');
  }finally{await service.close();}
});
test('one persisted configuration applies to both modes after restart; mode databases and execution authority stay separate',async()=>{
  const root=mkdtempSync(join(tmpdir(),'shared-config-'));
  try{
    const legacy=new Store(join(root,'paper.db'));
    legacy.set('settings',{...SettingsSchema.parse({codex_enabled:true,codex_model:'test-model',max_order_fraction:'0.06',stock_account_index:0}),fee_verified:false,settlement_debit_sign:'unverified'});
    legacy.close();const common=new DesktopSettings(root);common.migrate('live',0);
    const paper=common.apply(SettingsSchema.parse({}),'paper','http://127.0.0.1:9081');
    const live=common.apply(SettingsSchema.parse({}),'live','http://127.0.0.1:9082');
    assert.equal(live.codex_model,'test-model');assert.equal(live.codex_enabled,true);assert.equal(live.max_order_fraction,'0.06');
    assert.equal(live.auto_execute,false);assert.equal(paper.auto_execute,false);assert.ok(!('fee_verified' in live));
    common.save({...live,stock_account_index:2,codex_model:'other-model',auto_execute:true});
    const restored=new DesktopSettings(root),next=restored.apply(paper,'paper','http://127.0.0.1:9100');
    assert.equal(restored.accountIndex,2);assert.equal(next.codex_model,'other-model');assert.equal(next.auto_execute,false);
    const saved=JSON.parse(readFileSync(join(root,'common-settings.json'),'utf8'));
    for(const k of ['auto_execute','mode','base_url','api_key','secret_key','fee_verified','settlement_debit_sign'])assert.ok(!(k in saved.settings));
    const p=new TradingService(join(root,'paper-test.db'),'paper'),l=new TradingService(join(root,'live-test.db'),'live');
    try{p.store.set('paper_ledger',{cash:'12345',lots:[],orders:[],lastEvents:{},charges:{}});assert.equal(l.store.get('paper_ledger'),undefined);
      assert.equal(l.liveAuthorized,false);}finally{await p.close();await l.close();}
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('default paper historical loader completes a rules simulation through market endpoints with all account endpoints forbidden',async()=>{
  const root=mkdtempSync(join(tmpdir(),'market-only-replay-')),fixture=new ConnectionFixture();
  const dataset=syntheticDataset('2026-10-01','2026-10-08'),bars=dataset.points.filter(p=>p.symbol==='9001');
  const fetcher:typeof fetch=async(input,init)=>{
    const path=new URL(String(input)).pathname;
    if(path.endsWith('/data/contracts/9001/info')){fixture.paths.push(path);return Response.json({security_type:'STK',code:'9001',name:'SYNTHETIC',exchange:'TSE'});}
    if(path.endsWith('/data/kbars')){fixture.paths.push(path);const range=JSON.parse(String(init?.body));
      const points=bars.filter(p=>twDay(new Date(p.at))>=range.start&&twDay(new Date(p.at))<=range.end);
      return Response.json({datetime:points.map(p=>p.at),Open:points.map(p=>p.open),High:points.map(p=>p.high),Low:points.map(p=>p.low),Close:points.map(p=>p.close),Volume:points.map(p=>p.volume_shares/1000)});}
    if(/\/auth\/|\/portfolio\/|\/order\/|openapi/.test(path))throw new Error('Account endpoints forbidden in historical paper mode');
    return fixture.fetch(input,init);
  };
  try{
    const request=BacktestRequestSchema.parse({start:'2026-10-01',end:'2026-10-08',symbols:['9001'],source:'shioaji',strategy:'rules'});
    const settings=SettingsSchema.parse({});
    const loaded=await shioajiDataset(request,settings,root,new AbortController().signal,()=>undefined,fetcher);
    const report=await runBacktest(request,loaded,settings,undefined,new AbortController().signal);
    assert.equal(report.status,'COMPLETED');assert.equal(report.metrics.codex_calls,0);assert.ok(report.quality.covered_sessions>0);
    assert.ok(!fixture.paths.some(p=>/\/auth\/|\/portfolio\/|\/order\/|openapi/.test(p)));
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('native startup waits beyond info readiness for a usable health body, accepting a degraded session without CA',async()=>{
  const root=mkdtempSync(join(tmpdir(),'native-health-'));let probes=0;
  const child=new EventEmitter() as EventEmitter&{exitCode:number|null;kill:()=>boolean};child.exitCode=null;
  child.kill=()=>{child.exitCode=0;setImmediate(()=>child.emit('exit'));return true;};
  const native=new NativeConnection(root,async()=>join(root,'fixture-binary'),{
    origin:async()=>'http://127.0.0.1:9081',run:async()=>({stdout:'--no-open'}),launch:(()=>child) as unknown as typeof spawn,
    fetcher:async input=>String(input).endsWith('/health')?Response.json({status:'degraded',session_recovering:++probes<3,token_stale:false}):Response.json({simulation:false}),
  });
  try{await native.start(ConnectionInputSchema.parse({api_key:'TEST_KEY',secret_key:'TEST_SECRET',remember:false}));
    assert.equal(probes,3);assert.equal(native.connected,true);assert.equal(native.hasCa,false);
  }finally{await native.close();rmSync(root,{recursive:true,force:true});}
});

const fakeLogin=`
const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2),root=process.env.CODEX_HOME,marker=path.join(root,'test-ready');
if(args.includes('status')){process.stderr.write(fs.existsSync(marker)?'Logged in using ChatGPT':'Not logged in PRIVATE_TOKEN');process.exit(fs.existsSync(marker)?0:1);}
process.stdout.write('PRIVATE_TOKEN\\nhttps://malicious.invalid/login\\nhttps://auth.openai.com/');
setTimeout(()=>{process.stdout.write(args.includes('--device-auth')?'codex/device\\nABCD-EFGH\\n':'oauth/authorize?client_id=isolated&state=isolated\\n');},20);
setTimeout(()=>{fs.writeFileSync(marker,'no credentials');process.exit(0);},350);
`;
test('Codex login captures a fragmented official browser URL, exposes device code, and verifies completion with CLI status',async()=>{
  const root=mkdtempSync(join(tmpdir(),'codex-login-fixture-')),script=join(root,'fake-login.cjs'),opened:string[]=[];let ready=0;
  writeFileSync(script,fakeLogin);const profile=join(root,'profile');
  const auth=new CodexLogin(profile,async url=>{opened.push(url);},async()=>{ready++;},{sourceProfile:join(root,'empty'),binary:()=>process.execPath,
    run:(bin,args,options)=>promisify(execFile)(bin,[script,...args],options),launch:(bin,args,options)=>spawn(bin,[script,...args],options)});
  try{
    assert.equal(await auth.check(),false);auth.start(true);
    await until(()=>auth.status.can_open);assert.match(opened[0]!,/^https:\/\/auth.openai.com\/codex\/device/);
    assert.equal(opened.length,1);assert.equal(auth.status.device_code,'ABCD-EFGH');assert.ok(!auth.status.message.includes('PRIVATE_TOKEN'));
    assert.equal(await auth.check(),false);assert.equal(auth.status.state,'pending');assert.equal(auth.status.can_open,true);
    await auth.reopen();assert.equal(opened.length,2);await auth.wait();assert.equal(auth.status.state,'ready');assert.equal(ready,1);
    assert.equal(auth.status.can_open,false);assert.equal(auth.status.device_code,'');assert.ok(existsSync(join(profile,'config.toml')));
    assert.equal(readFileSync(join(profile,'config.toml'),'utf8').includes('shell_tool = false'),true);
    auth.start();await auth.wait();assert.equal(opened.length,3);assert.match(opened[2]!,/oauth\/authorize/);
  }finally{auth.close();await auth.wait();rmSync(root,{recursive:true,force:true});}
});
test('Codex browser handoff rejects arbitrary origins, credentials, ports and paths',()=>{
  assert.ok(loginUrl('https://auth.openai.com/oauth/authorize?state=test'));
  assert.ok(loginUrl('https://chatgpt.com/deviceauth'));
  for(const url of ['http://auth.openai.com/oauth/authorize','https://auth.openai.com.evil.example/oauth/authorize',
    'https://user:password@auth.openai.com/oauth/authorize','https://auth.openai.com:444/oauth/authorize',
    'https://auth.openai.com/unrelated','file:///tmp/login'])assert.equal(loginUrl(url),undefined);
});
test('Codex probe validates a model response and preserves actionable authentication errors without stderr or tokens',async()=>{
  const root=mkdtempSync(join(tmpdir(),'codex-probe-'));let rejected=false,calls=0;
  const tested=new CodexLogin(root,async()=>undefined,async()=>undefined,{sourceProfile:join(root,'empty'),run:async()=>({}),
    probe:async()=> (async function*(){calls++;if(rejected){yield {type:'turn.failed',error:{message:'401 Unauthorized PRIVATE_TOKEN'}} as ThreadEvent;return;}
      yield {type:'item.completed',item:{type:'agent_message',id:'test',text:'{"ok":true}'}} as ThreadEvent;
      yield {type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1,cache_write_input_tokens:0,reasoning_output_tokens:0}} as ThreadEvent;
    })()});
  try{assert.match(await tested.test(SettingsSchema.parse({})),/測試成功/);rejected=true;
    await assert.rejects(tested.test(SettingsSchema.parse({})),/登入已過期/);assert.equal(tested.status.state,'error');assert.equal(calls,2);assert.ok(!tested.status.message.includes('PRIVATE_TOKEN'));
  }finally{tested.close();rmSync(root,{recursive:true,force:true});}
});
test('Codex structured output requires every property, including optional nullable screening, at each object level',()=>{
  const visit=(node:unknown):void=>{if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return;}
    const n=node as Record<string,unknown>;if(n.properties){assert.deepEqual(n.required,Object.keys(n.properties));assert.equal(n.additionalProperties,false);}
    Object.values(n).forEach(visit);};
  const schema=codexOutputSchema() as {required:string[]};assert.ok(schema.required.includes('screening'));visit(schema);
});
test('failed analyst emits a safe authentication diagnosis while financial decisions remain unactivated',async()=>{
  const events:string[]=[],runner:Runner=async()=>({events:(async function*(){yield {type:'turn.failed',error:{message:'401 authentication failed PRIVATE_TOKEN'}} as ThreadEvent;})()});
  const analyst=new CodexAnalyst(SettingsSchema.parse({codex_enabled:true}),'/unused',runner,undefined,event=>events.push(event.message));
  await assert.rejects(analyst.analyze(snapshot()),/登入已過期/);assert.ok(!events.join('').includes('PRIVATE_TOKEN'));
  assert.ok(!codexIssue(new Error('network PRIVATE_TOKEN')).includes('PRIVATE_TOKEN'));
  assert.ok(!('settlement_debit_sign' in storedSettings({...SettingsSchema.parse({}),settlement_debit_sign:'unverified'})));
});
