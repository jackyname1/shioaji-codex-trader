import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ShioajiHttpBroker} from '../src/broker/http.js';
import {brokerIssue} from '../src/broker/health.js';
import {NoSubmissionError} from '../src/broker/types.js';
import {Store} from '../src/core/store.js';
import {SettingsSchema,twDay} from '../src/core/models.js';

class RecoveryFixture {
  clock=Date.now();recovering=false;ca=true;bankStatus=200;badBank=false;subscriptions=0;mutations=0;
  calls:string[]=[];cache={state:'Healthy',reasons:[] as {reason:string}[]};
  fetch:typeof fetch=async(input,init)=>{
    const path=new URL(String(input)).pathname.replace('/api/v1','');this.calls.push(path);
    if(path==='/info')return Response.json({simulation:false,version:'1.7.7'});
    if(path==='/health')return Response.json({status:'healthy',session_recovering:this.recovering,token_stale:false,
      token_expires_in_seconds:3600,ca_expired:!this.ca,ca_expires_in_days:this.ca?30:0});
    if(path==='/auth/accounts')return Response.json([{account_type:'S',broker_id:'PRIVATE_BROKER',account_id:'PRIVATE_ACCOUNT',signed:true}]);
    if(path==='/stream/data')return new Response(new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('event: heartbeat\ndata: {}\n\n'));init?.signal?.addEventListener('abort',()=>c.close(),{once:true});}}),{headers:{'content-type':'text/event-stream'}});
    if(path==='/order/trade_cache_health')return Response.json(this.cache);
    if(path==='/auth/subscribe_trade'){this.subscriptions++;this.cache={state:'Healthy',reasons:[]};return Response.json({subscribe_trade:true});}
    if(path==='/order/trades')return Response.json([]);
    if(path==='/portfolio/account_balance')return this.bankStatus===200?Response.json({acc_balance:this.badBank?'PRIVATE_BAD_NUMBER':100000,date:twDay(new Date(this.clock)),errmsg:''}):Response.json({error:'PRIVATE_SECRET'}, {status:this.bankStatus,headers:{'retry-after':'10'}});
    if(path==='/portfolio/settlements')return Response.json([]);
    if(path==='/portfolio/position_unit')return Response.json([{id:0,code:'9001',direction:'Buy',cond:'Cash',quantity:1050,yd_quantity:1050,price:30,last_price:31}]);
    if(/place_order|cancel_order/.test(path)){this.mutations++;throw new Error('No mutation is permitted');}
    throw new Error('No other endpoint is permitted');
  };
}
async function rig(){const fixture=new RecoveryFixture(),store=new Store(':memory:');
  const broker=new ShioajiHttpBroker(store,SettingsSchema.parse({mode:'live'}),true,fixture.fetch,undefined,()=>fixture.clock);
  await broker.connect();return {fixture,store,broker,account:()=>broker.account(new Date(fixture.clock)),close:async()=>{await broker.close();store.close();}};}

test('cached native login does not re-subscribe an already healthy trade relay',async()=>{
  const r=await rig();try{const a=await r.account();assert.equal(a.complete,true);assert.equal(r.fixture.subscriptions,0);
    assert.ok(r.fixture.calls.indexOf('/order/trade_cache_health')<r.fixture.calls.indexOf('/order/trades'));
    assert.equal(r.fixture.mutations,0);
  }finally{await r.close();}
});
test('an SSE gap rechecks cache health and subscribes only when the relay was actually lost',async()=>{
  const r=await rig();try{await r.account();r.fixture.cache={state:'Unknown',reasons:[{reason:'NotSubscribed'}]};
    r.broker.handleFrame({event:'order_gap',id:'isolated-gap',data:'{}'});
    assert.equal((await r.account()).complete,true);assert.equal(r.fixture.subscriptions,1);
    await r.account();assert.equal(r.fixture.subscriptions,1);assert.equal(r.fixture.mutations,0);
  }finally{await r.close();}
});
test('session recovery pauses private account requests, keeps successful holdings, then recovers without a login loop',async()=>{
  const r=await rig();try{const first=await r.account();r.fixture.clock+=6000;r.fixture.recovering=true;
    const offset=r.fixture.calls.length,stale=await r.account();assert.equal(stale.complete,false);assert.deepEqual(stale.positions,first.positions);
    assert.equal(stale.asof,first.asof);assert.match(stale.issue,/券商連線正在恢復/);
    assert.ok(r.fixture.calls.slice(offset).every(p=>p==='/health'));
    r.fixture.clock+=6000;r.fixture.recovering=false;assert.equal((await r.account()).complete,true);
    assert.equal(r.fixture.subscriptions,0);assert.equal(r.fixture.mutations,0);
  }finally{await r.close();}
});
test('HTTP 429 honors retry-after without hammering the bank; independent holdings remain visible',async()=>{
  const r=await rig();try{r.fixture.bankStatus=429;const first=await r.account();assert.equal(first.complete,false);assert.equal(first.positions[0]!.shares,1050);
    const count=r.fixture.calls.filter(p=>p==='/portfolio/account_balance').length;
    r.fixture.bankStatus=200;r.fixture.clock+=1000;assert.equal((await r.account()).complete,false);
    assert.equal(r.fixture.calls.filter(p=>p==='/portfolio/account_balance').length,count);
    assert.match(r.broker.diagnosticSnapshot().endpoints.find(e=>e.endpoint==='/portfolio/account_balance')!.issue,/429/);
    r.fixture.clock+=10001;assert.equal((await r.account()).complete,true);
    assert.equal(r.fixture.calls.filter(p=>p==='/portfolio/account_balance').length,count+1);
  }finally{await r.close();}
});
test('bank format failure identifies its endpoint and field without dropping positions or leaking native values',async()=>{
  const r=await rig();try{r.fixture.badBank=true;const a=await r.account();assert.equal(a.complete,false);assert.equal(a.available!.positions,true);
    assert.match(a.issue,/交割戶餘額.*acc_balance/);assert.ok(!a.issue.includes('PRIVATE_BAD_NUMBER'));
    const json=JSON.stringify(r.broker.diagnosticSnapshot());assert.ok(!/PRIVATE_ACCOUNT|PRIVATE_BROKER|PRIVATE_BAD_NUMBER/.test(json));
    r.fixture.badBank=false;assert.equal((await r.account()).complete,true);
  }finally{await r.close();}
});
test('pre-submit readiness refusals retain their actual CA/connection reason instead of the generic data error',async()=>{
  const r=await rig();try{r.fixture.ca=false;
    await assert.rejects(r.broker.verifyLiveConnection(),error=>error instanceof NoSubmissionError&&/有效 CA/.test(brokerIssue(error)));
    assert.ok(!brokerIssue(new Error('PRIVATE_SECRET')).includes('PRIVATE_SECRET'));assert.equal(r.fixture.mutations,0);
  }finally{await r.close();}
});
