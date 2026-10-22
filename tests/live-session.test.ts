import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LiveSession } from '../src/core/live-session.js';
import { TradingService } from '../src/core/service.js';
import { Store } from '../src/core/store.js';
import { SettingsSchema, twDay } from '../src/core/models.js';
import { ShioajiHttpBroker } from '../src/broker/http.js';
import { NoSubmissionError } from '../src/broker/types.js';
import { DesktopOperations } from '../src/desktop/operations.js';
import { order } from './helpers.js';

// All calls are handled in memory. This fixture cannot reach a broker or use account credentials.
class NativeFixture {
  account = 'SYNTHETIC'; ca = true; expires = 3600; mutations = 0;
  onHealth?: () => void;
  trades: ReturnType<NativeFixture['trade']>[] = [];
  trade(filled=10, status='PartFilled') {
    return { contract:{code:'9001',security_type:'STK',exchange:'TSE'},
      order:{id:'fixture-order',action:'Buy',price:'30.05',quantity:30,order_lot:'IntradayOdd',order_cond:'Cash',
        price_type:'LMT',order_type:'ROD',custom_field:'abcdef',account:{account_type:'S',broker_id:'TEST',account_id:this.account,signed:true}},
      status:{status,order_ts:Date.now()/1000,order_quantity:30,deal_quantity:filled} };
  }
  fetch: typeof fetch = async (input,init) => {
    const path = new URL(String(input)).pathname;
    if(path.endsWith('/stream/data'))return new Response(new ReadableStream<Uint8Array>({start(controller){
      controller.enqueue(new TextEncoder().encode('event: heartbeat\ndata: {}\n\n'));
      init?.signal?.addEventListener('abort',()=>controller.close(),{once:true});
    }}),{headers:{'Content-Type':'text/event-stream'}});
    if(path.endsWith('/info'))return Response.json({simulation:false,version:'1.7.7'});
    if(path.endsWith('/health')){this.onHealth?.();return Response.json({status:'healthy',token_stale:false,
      token_expires_in_seconds:this.expires,ca_expired:!this.ca,ca_expires_in_days:this.ca?30:0});}
    if(path.endsWith('/auth/accounts'))return Response.json([{account_type:'S',broker_id:'TEST',account_id:this.account,signed:true}]);
    if(path.endsWith('/auth/subscribe_trade'))return Response.json({subscribe_trade:true});
    if(path.endsWith('/openapi.json'))return Response.json({paths:Object.fromEntries([
      '/api/v1/order/trades','/api/v1/order/trade_cache_health','/api/v1/portfolio/position_unit','/api/v1/portfolio/position_detail',
      '/api/v1/stream/data','/api/v1/data/contracts/{code}/info'].map(p=>[p,{}]))});
    if(path.endsWith('/order/trades'))return Response.json(this.trades);
    if(path.endsWith('/portfolio/account_balance'))return Response.json({acc_balance:100000,date:twDay(new Date()),errmsg:''});
    if(path.endsWith('/portfolio/settlements')||path.endsWith('/portfolio/position_unit'))return Response.json([]);
    if(path.endsWith('/order/trade_cache_health'))return Response.json({state:'Healthy',reasons:[]});
    if(path.endsWith('/stream/subscribe')||path.endsWith('/stream/unsubscribe'))return Response.json({success:true});
    if(path.endsWith('/data/contracts/9001/info'))return Response.json({security_type:'STK',code:'9001',exchange:'TSE',name:'虛構股票',
      category:'TEST',reference:30,limit_down:27,limit_up:33,trading_suspended:false,disposition_level:0,attention_flag:false,update_date:twDay(new Date())});
    if(path.endsWith('/order/cancel_order')){this.mutations++;this.trades=[this.trade(17,'Cancelled')];return Response.json(this.trades[0]);}
    if(path.endsWith('/order/place_order')){this.mutations++;throw new Error('This fixture never permits a new order.');}
    throw new Error('Unexpected isolated endpoint: '+path);
  };
}
async function serviceFixture(f = new NativeFixture(), path=':memory:') {
  const service = new TradingService(path,'live',(store,s,session)=>new ShioajiHttpBroker(store,s,true,f.fetch,session));
  await service.saveSettings({...service.engine.settings,codex_enabled:true,auto_watchlist:false});
  await service.start(false);
  const plan={id:'fixture-plan',created_at:new Date().toISOString(),analysis:{snapshot_id:'fixture-snapshot',
    expires_at:new Date(Date.now()+3600000).toISOString(),stance:'HOLD_ONLY' as const,candidates:[],decisions:[],summary:'隔離測試，沒有下單策略'}};
  service.store.set('plan',plan);service.engine.plan=plan;
  return {service,f};
}

// Isolate legacy session/queue tests from the separate production qualification gate.
// There is no production certificate and no network: this fixture grants only a mocked in-memory session.
async function grantIsolatedSession(service:TradingService){
  await service.activateLive('cancel');
  service.liveSession.grant(service.store.get<string>('account_fingerprint')!,'trade');
}
test('live session is bound to one account and cancellation permission never enables new orders',()=>{
  const session=new LiveSession(),account='a'.repeat(64);
  assert.equal(session.authorized(account),false);assert.throws(()=>session.grant(''));
  session.grant(account,'cancel');assert.equal(session.authorized(account),false);assert.equal(session.authorized(account,'cancel'),true);
  session.grant(account);assert.equal(session.authorized(account),true);assert.equal(session.authorized('b'.repeat(64)),false);
  session.revoke();assert.equal(session.authorized(account,'cancel'),false);
});
test('one session grant starts live automation without an environment flag; pause/resume retains it and stop revokes it',async()=>{
  const original=process.env.LIVE_TRADING;delete process.env.LIVE_TRADING;
  const {service,f}=await serviceFixture();
  try {
    await assert.rejects(service.command('auto on'),/本次實盤授權/);
    assert.equal(service.liveReadiness().ready,false);assert.equal(service.liveReadiness(new Date(),'cancel').ready,true);await grantIsolatedSession(service);await service.command('start-auto');
    assert.equal(service.engine.settings.auto_execute,true);assert.equal(service.liveAuthorized,true);
    await service.command('pause');await service.command('resume');assert.equal(service.liveAuthorized,true);
    await service.command('stop');assert.equal(service.liveAuthorized,false);assert.equal(service.engine.settings.auto_execute,false);
    await service.command('continue');await assert.rejects(service.command('auto on'),/本次實盤授權/);
    assert.equal(service.store.get('live_consent'),undefined);assert.equal(f.mutations,0);
  } finally {await service.close();if(original===undefined)delete process.env.LIVE_TRADING;else process.env.LIVE_TRADING=original;}
});
test('restart ignores legacy persisted consent and auto-execute, and changing trade limits closes the current grant',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'session-restart-')),path=join(dir,'live.db');
  let current:TradingService|undefined;
  try {
    const first=await serviceFixture(new NativeFixture(),path);current=first.service;
    await grantIsolatedSession(current);await current.command('auto on');
    await current.saveSettings({...current.engine.settings,max_order_fraction:'0.05'});
    assert.equal(current.liveAuthorized,false);assert.equal(current.engine.settings.auto_execute,false);
    current.store.set('live_consent',{fingerprint:current.store.get('account_fingerprint'),at:new Date().toISOString()});
    current.store.saveSettings({...current.engine.settings,auto_execute:true});await current.close();current=undefined;
    const next=await serviceFixture(new NativeFixture(),path);current=next.service;
    assert.equal(current.liveAuthorized,false);assert.equal(current.engine.settings.auto_execute,false);assert.equal(current.store.get('live_consent'),undefined);
  } finally {await current?.close();rmSync(dir,{recursive:true,force:true});}
});
test('live monitoring works without CA while authorization identifies the missing requirement',async()=>{
  const f=new NativeFixture();f.ca=false;const {service}=await serviceFixture(f);
  try {
    assert.equal(service.engine.connected,true);assert.ok(service.liveReadiness().issues.some(i=>i.includes('CA')));
    await assert.rejects(service.activateLive(),/CA/);assert.equal(service.liveAuthorized,false);assert.equal(f.mutations,0);
  } finally {await service.close();}
});
test('built-in costs need no manual confirmation; expired login and uncertain orders cannot obtain a grant',async()=>{
  const {service,f}=await serviceFixture();
  try {
    assert.ok(!service.liveReadiness().issues.some(i=>/手續費|交割款符號/.test(i)));
    await grantIsolatedSession(service);assert.equal(service.liveAuthorized,true);await service.command('lock-live');
    f.expires=0;await assert.rejects(service.activateLive(),/過期/);f.expires=3600;
    service.store.saveOrder(order({status:'UNKNOWN',created_at:new Date().toISOString()}));
    await assert.rejects(service.activateLive(),/待核對/);assert.equal(f.mutations,0);
  } finally {await service.close();}
});
test('broker refuses persisted consent, changed accounts and revoked grants before any mutation request',async()=>{
  const f=new NativeFixture();f.trades=[f.trade()];const {service}=await serviceFixture(f);
  const local=order({broker_id:'fixture-order',status:'PARTIAL',filled:10,created_at:new Date().toISOString()});
  try {
    service.store.set('live_consent',{fingerprint:service.store.get('account_fingerprint')});
    await assert.rejects(service.broker.cancel(local),NoSubmissionError);assert.equal(f.mutations,0);
    await grantIsolatedSession(service);f.onHealth=()=>service.liveSession.revoke();
    await assert.rejects(service.broker.cancel(local),NoSubmissionError);assert.equal(f.mutations,0);f.onHealth=undefined;
    await grantIsolatedSession(service);f.account='DIFFERENT';
    await assert.rejects(service.broker.cancel(local),NoSubmissionError);assert.equal(service.liveAuthorized,false);assert.equal(f.mutations,0);
  } finally {await service.close();}
});
test('cancel-only grant preserves additional fills reported during cancel and records them once',async()=>{
  const f=new NativeFixture();f.trades=[f.trade()];const {service}=await serviceFixture(f);
  try {
    const local=order({broker_id:'fixture-order',status:'PARTIAL',filled:10,created_at:new Date().toISOString()});service.store.saveOrder(local);
    await service.activateLive('cancel');assert.equal(service.liveAuthorized,false);assert.equal(service.liveCancelAuthorized,true);
    await assert.rejects(service.broker.submit(local),NoSubmissionError);assert.equal(f.mutations,0);
    await service.command('cancel '+local.local_id);assert.equal(f.mutations,1);assert.equal(service.store.orders()[0]!.filled,17);
    assert.equal(service.store.orders()[0]!.status,'CANCELLED');assert.equal(service.engine.settings.auto_execute,false);
    const fills=service.store.experiences('live',new Date().toISOString()).filter(e=>e.kind==='RECONCILED_FILL');
    assert.deepEqual(fills.map(e=>e.shares),[7]);await service.command('reconcile');
    assert.equal(service.store.experiences('live',new Date().toISOString()).filter(e=>e.kind==='RECONCILED_FILL').length,1);
  } finally {await service.close();}
});
test('port changes keep account identity stable and legacy migration verifies the old selected account',async()=>{
  const store=new Store(':memory:'),f=new NativeFixture();let broker:ShioajiHttpBroker|undefined;
  const connect=async(base_url:string)=>{broker=new ShioajiHttpBroker(store,SettingsSchema.parse({mode:'readonly',base_url}),false,f.fetch);await broker.connect();};
  try {
    await connect('http://127.0.0.1:18981');const identity=store.get('account_fingerprint');await broker!.close();
    await connect('http://127.0.0.1:29876');assert.equal(store.get('account_fingerprint'),identity);await broker!.close();
    store.delete('account_identity_version');store.set('legacy_account_origin','http://127.0.0.1:18981');
    const legacy=createHash('sha256').update(JSON.stringify({account_type:'S',broker_id:'TEST',account_id:f.account,simulation:false,origin:'http://127.0.0.1:18981/api/v1'})).digest('hex');
    store.set('account_fingerprint',legacy);await connect('http://127.0.0.1:39876');
    assert.equal(store.get('account_fingerprint'),identity);assert.equal(store.get('account_identity_version'),2);await broker!.close();
    f.account='OTHER';await assert.rejects(connect('http://127.0.0.1:49876'),/帳戶身分/);
  } finally {await broker?.close();store.close();}
});
test('desktop account changes and consent prompts reject concurrent operations and release their lock after failure',async()=>{
  const operations=new DesktopOperations();let finish!:()=>void;
  const first=operations.run(()=>new Promise<void>(resolve=>{finish=resolve;}));
  assert.equal(operations.busy,true);await assert.rejects(operations.run(async()=>undefined),/仍在進行/);
  finish();await first;assert.equal(operations.busy,false);
  await assert.rejects(operations.run(async()=>{throw new Error('fixture');}),/fixture/);assert.equal(operations.busy,false);
});
test('emergency stop immediately revokes permission even while an earlier queue operation is waiting',async()=>{
  const {service}=await serviceFixture();let release!:()=>void;
  try {
    await grantIsolatedSession(service);const blocked=service.enqueue(()=>new Promise<void>(resolve=>{release=resolve;}));
    await Promise.resolve();const stopped=service.command('stop');assert.equal(service.liveAuthorized,false);
    release();await blocked;await stopped;assert.equal(service.engine.killed,true);
  } finally {release?.();await service.close();}
});
test('authorization in progress cannot replace a competing emergency stop with a new grant',async()=>{
  const {service,f}=await serviceFixture();let stopped:Promise<string>|undefined;
  try {
    f.onHealth=()=>{f.onHealth=undefined;stopped=service.command('stop');};
    await assert.rejects(service.activateLive('cancel'),/實盤啟動已停止/);await stopped;
    assert.equal(service.liveAuthorized,false);assert.equal(service.engine.killed,true);assert.equal(f.mutations,0);
  } finally {await service.close();}
});
test('an emergency stop cannot be undone by competing automation startup',async()=>{
  const service=new TradingService(':memory:','demo');
  try {
    await service.start(false);service.engine.plan={id:'fixture',created_at:new Date().toISOString(),analysis:{snapshot_id:'fixture',
      expires_at:new Date(Date.now()+3600000).toISOString(),stance:'HOLD_ONLY',candidates:[],decisions:[],summary:'fixture'}};
    await Promise.all([service.command('start-auto'),service.command('stop')]);assert.equal(service.engine.killed,true);
    assert.equal(service.store.orders().length,0);
  } finally {await service.close();}
});
test('cancelled analysis cannot activate a completed result waiting in the engine queue',async()=>{
  const service=new TradingService(':memory:','demo');let release!:()=>void;
  try {
    await service.start(false);const blocked=service.enqueue(()=>new Promise<void>(resolve=>{release=resolve;}));
    await Promise.resolve();const decision=service.decide();const rejection=assert.rejects(decision,/本輪決策未啟用/);
    await service.command('cancel-analysis');release();await blocked;await rejection;
    assert.equal(service.engine.plan,undefined);assert.equal(service.store.plan(),undefined);
  } finally {release?.();await service.close();}
});

test('even a healthy broker and legacy consent cannot bypass missing independent validation',async()=>{
  const {service,f}=await serviceFixture();try{
    service.store.set('live_consent',{approved:true});
    assert.equal(service.liveReadiness().ready,false);
    assert.equal(service.liveReadiness(new Date(),'cancel').ready,true);
    await assert.rejects(service.activateLive(),/LIVE_VALIDATION_PENDING/);
    await assert.rejects(service.command('auto on'),/本次實盤授權/);
    assert.equal(service.liveAuthorized,false);assert.equal(f.mutations,0);
  }finally{await service.close();}
});
