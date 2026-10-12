import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';
import {TradingService} from '../src/core/service.js';
import {SettingsSchema,twDay} from '../src/core/models.js';
import {DesktopSettings} from '../src/desktop/settings.js';
import {openWorkspace,workspaceFailure,WorkspaceProfileError} from '../src/desktop/workspace-profile.js';
import {ShioajiHttpBroker} from '../src/broker/http.js';
import {order} from './helpers.js';

/** Actual loopback HTTP, the same selectors/methods/Share unit used by Pro.
 * Every value is synthetic; mutation routes are forbidden and counted. */
async function proServer(){
  const requests:{path:string;method:string;body:Record<string,unknown>}[]=[];let mutations=0;
  const server=createServer(async(req,res)=>{
    const path=new URL(req.url!,'http://localhost').pathname;
    let input='';for await(const chunk of req)input+=String(chunk);
    const body=input?JSON.parse(input) as Record<string,unknown>:{};
    requests.push({path,method:req.method!,body});
    if(/place_order|cancel_order|update_qty|update_price/.test(path)){mutations++;res.writeHead(403);res.end('{}');return;}
    if(path==='/api/v1/stream/data'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: heartbeat\ndata: {}\n\n');return;}
    let data:unknown;
    if(path==='/api/v1/info')data={simulation:false,version:'1.7.7'};
    else if(path==='/api/v1/health')data={status:'healthy',token_stale:false,session_recovering:false,ca_expired:false,ca_expires_in_days:90};
    else if(path==='/api/v1/auth/accounts')data=[{account_type:'S',broker_id:'SYNTHETIC',account_id:'SYNTHETIC_ACCOUNT',signed:true}];
    else if(path==='/api/v1/auth/subscribe_trade')data={subscribe_trade:true};
    else if(path==='/api/v1/order/trade_cache_health')data={state:'Healthy',reasons:[]};
    else if(path==='/api/v1/portfolio/account_balance')data={acc_balance:123456,date:twDay(new Date())+' 22:15:00.123456',errmsg:''};
    else if(['/api/v1/order/trades','/api/v1/portfolio/settlements','/api/v1/portfolio/position_unit'].includes(path))data=[];
    else {res.writeHead(404);res.end('{}');return;}
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');
  return {server,base:'http://127.0.0.1:'+address.port,requests,get mutations(){return mutations;}};
}
async function close(server:Server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}

test('legacy readonly real-account history can enter live without discarding intents or granting execution',async()=>{
  const root=mkdtempSync(join(tmpdir(),'profile-real-history-')),path=join(root,'live.db');
  try{
    const original=new Store(path);original.set('database_mode','readonly');original.set('account_fingerprint','SYNTHETIC_IDENTITY');
    const intent=order({local_id:'SYNTHETIC_INTENT',tag:'SYN001'});original.insertIntent(intent);original.close();
    const service=new TradingService(path,'live');
    try{assert.equal(service.store.get('database_mode'),'live');assert.deepEqual(service.store.orders(),[intent]);
      assert.equal(service.store.get('account_fingerprint'),'SYNTHETIC_IDENTITY');assert.equal(service.liveAuthorized,false);assert.equal(service.engine.settings.auto_execute,false);
    }finally{await service.close();}
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('an incompatible journal still allows Pro-compatible real HTTP account reads, with zero live mutations',async()=>{
  const root=mkdtempSync(join(tmpdir(),'profile-readonly-http-')),path=join(root,'live.db'),fixture=await proServer();
  let service:TradingService|undefined;
  try{
    const original=new Store(path);original.set('schema_version',999);original.set('keep_history',{marker:'SYNTHETIC_KEPT'});original.close();
    const before=readFileSync(path),common=new DesktopSettings(root);
    const opened=openWorkspace(root,'live',fixture.base,common,undefined,undefined,true);service=opened.service;
    assert.equal(opened.diagnostic.code,'SCHEMA_VERSION');assert.equal(opened.diagnostic.state,'read_only');
    await service.start(false);assert.equal(service.engine.connected,true);assert.equal(service.engine.account?.cash,'123456');
    const deadline=Date.now()+2000;
    while(service.broker instanceof ShioajiHttpBroker&&!service.broker.diagnosticSnapshot().stream_connected&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
    await service.engine.refreshAccount(new Date());
    assert.equal(service.engine.account?.complete,true);assert.equal(service.liveReadiness().ready,false);assert.equal(service.liveAuthorized,false);
    await assert.rejects(service.activateLive(),/SCHEMA_VERSION/);assert.equal(fixture.mutations,0);
    for(const route of ['account_balance','settlements','position_unit']){
      const request=fixture.requests.find(r=>r.path==='/api/v1/portfolio/'+route)!;
      assert.equal(request.method,'POST');assert.deepEqual(request.body,{account_type:'S',broker_id:'SYNTHETIC',account_id:'SYNTHETIC_ACCOUNT',...(route==='position_unit'?{unit:'Share'}:{})});
    }
    assert.ok(service.broker instanceof ShioajiHttpBroker);
    assert.ok(service.broker.diagnosticSnapshot().endpoints.some(e=>e.endpoint==='/portfolio/account_balance'&&e.successes>0));
    assert.deepEqual(readFileSync(path),before);
    assert.ok(!JSON.stringify(opened.diagnostic).includes('SYNTHETIC'));
    // The failing constructor closed SQLite and released its own lock, so repair/retry remains possible.
    const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path);db.prepare('UPDATE kv SET value=? WHERE key=?').run('2','schema_version');db.close();
    const retry=new Store(path);assert.deepEqual(retry.get('keep_history'),{marker:'SYNTHETIC_KEPT'});retry.close();
  }finally{await service?.close();await close(fixture.server);rmSync(root,{recursive:true,force:true});}
});

test('simulated history is never migrated or used to authorize the real-account reader',async()=>{
  const root=mkdtempSync(join(tmpdir(),'profile-simulated-history-')),fixture=await proServer();let service:TradingService|undefined;
  try{
    const original=new Store(join(root,'live.db'));original.set('database_mode','paper');original.insertIntent(order({local_id:'SYNTHETIC_PAPER',tag:'SYN002'}));original.close();
    const opened=openWorkspace(root,'live',fixture.base,new DesktopSettings(root));service=opened.service;
    assert.equal(opened.diagnostic.code,'MODE_MISMATCH');await service.start(false);assert.equal(service.engine.account?.cash,'123456');
    assert.equal(service.store.orders().length,0);assert.equal(service.liveReadiness().ready,false);assert.equal(fixture.mutations,0);
    const kept=new Store(join(root,'live.db'));assert.equal(kept.get('database_mode'),'paper');assert.equal(kept.orders()[0]?.local_id,'SYNTHETIC_PAPER');kept.close();
  }finally{await service?.close();await close(fixture.server);rmSync(root,{recursive:true,force:true});}
});

test('unusable persisted strategy data retains its original value while real-account reads recover safely',async()=>{
  const root=mkdtempSync(join(tmpdir(),'profile-old-plan-')),fixture=await proServer();let service:TradingService|undefined;
  try{
    const original=new Store(join(root,'live.db'));original.set('plan',{legacy:'SYNTHETIC_PLAN'});original.close();
    const opened=openWorkspace(root,'live',fixture.base,new DesktopSettings(root));service=opened.service;
    assert.equal(opened.diagnostic.code,'SAVED_DATA_FORMAT');await service.start(false);assert.equal(service.engine.account?.cash,'123456');
    assert.equal(service.liveReadiness().ready,false);const kept=new Store(join(root,'live.db'));assert.deepEqual(kept.get('plan'),{legacy:'SYNTHETIC_PLAN'});kept.close();
  }finally{await service?.close();await close(fixture.server);rmSync(root,{recursive:true,force:true});}
});

test('workspace diagnostics keep stage and safe error codes without copying account/path/exception data',()=>{
  for(const code of ['EACCES','EPERM','ERR_SQLITE_ERROR']){
    const diagnostic=workspaceFailure('live','database',Object.assign(new Error('SYNTHETIC_SECRET C:\\SYNTHETIC_ACCOUNT\\private.db'),{code,errcode:5}));
    assert.match(diagnostic.issue,new RegExp(code));assert.equal(diagnostic.stage,'database');assert.ok(!JSON.stringify(diagnostic).includes('SYNTHETIC'));
  }
  assert.equal(workspaceFailure('live','engine',new ReferenceError('SYNTHETIC_SECRET')).code,'ReferenceError');
});

test('closing a store twice is safe and leaves the journal available to the next workspace',()=>{
  const root=mkdtempSync(join(tmpdir(),'profile-close-')),path=join(root,'live.db');
  try{const store=new Store(path);store.close();store.close();const retry=new Store(path);retry.close();}finally{rmSync(root,{recursive:true,force:true});}
});

test('paper workspace failures remain explicit and never silently replace a simulated portfolio',()=>{
  const root=mkdtempSync(join(tmpdir(),'profile-paper-error-'));
  try{const s=new Store(join(root,'paper.db'));s.set('schema_version',999);s.close();
    assert.throws(()=>openWorkspace(root,'paper','http://127.0.0.1:8080',new DesktopSettings(root)),e=>e instanceof WorkspaceProfileError&&e.diagnostic.code==='SCHEMA_VERSION');
  }finally{rmSync(root,{recursive:true,force:true});}
});
