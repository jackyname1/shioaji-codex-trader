import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {ThreadEvent} from '@openai/codex-sdk';
import {TradingService} from '../src/core/service.js';
import {SettingsSchema,twDay,type Settings} from '../src/core/models.js';
import {ShioajiHttpBroker} from '../src/broker/http.js';
import {BrokerError} from '../src/broker/health.js';
import {Store} from '../src/core/store.js';
import {cachedHistory} from '../src/core/history-cache.js';
import {CredentialVault,ConnectionInputSchema,connectionInput} from '../src/desktop/credentials.js';
import {CodexLogin} from '../src/desktop/codex-login.js';

// No external account, auth, network or mutation is used. Non-display endpoints are deliberately unavailable.
class StartupFixture {
  paths:string[]=[];balanceFails=false;balanceDay?:string;reportsFail=false;ca=true;mutations=0;
  positions=[{id:0,code:'9001',direction:'Buy',cond:'Cash',quantity:1050,yd_quantity:1050,price:30,last_price:31}];
  trades:unknown[]=[];
  fetch:typeof fetch=async(input,init)=>{
    const path=new URL(String(input)).pathname;this.paths.push(path);
    if(path==='/api/v1/info')return Response.json({simulation:false,version:'1.7.7'});
    if(path.endsWith('/health'))return Response.json({status:'healthy',ca_expired:!this.ca,ca_expires_in_days:this.ca?30:0,token_stale:false,token_expires_in_seconds:3600});
    if(path.endsWith('/auth/accounts'))return Response.json([{account_type:'S',broker_id:'TEST',account_id:'ISOLATED',signed:true}]);
    if(path.endsWith('/stream/data'))return new Response(new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('event: heartbeat\ndata: {}\n\n'));init?.signal?.addEventListener('abort',()=>c.close(),{once:true});}}),{headers:{'content-type':'text/event-stream'}});
    if(path.endsWith('/auth/subscribe_trade'))return Response.json({subscribe_trade:true});
    if(path.endsWith('/order/trades'))return this.reportsFail?Response.json({error:'PRIVATE_ACCOUNT_VALUE'},{status:503}):Response.json(this.trades);
    if(path.endsWith('/order/trade_cache_health'))return Response.json({state:'Healthy',reasons:[]});
    if(path.endsWith('/portfolio/account_balance'))return this.balanceFails?Response.json({error:'PRIVATE_ACCOUNT_VALUE'},{status:503}):Response.json({acc_balance:100000,date:(this.balanceDay??twDay(new Date()))+' 10:05:00.123456',errmsg:''});
    if(path.endsWith('/portfolio/settlements'))return Response.json([{date:twDay(new Date()),T:1,amount:1200}]);
    if(path.endsWith('/portfolio/position_unit')){assert.equal(JSON.parse(String(init?.body)).unit,'Share');return Response.json(this.positions);}
    if(path.endsWith('/portfolio/position_detail'))throw new Error('Display must not require detail IDs, Common units or acquisition dates');
    if(path.endsWith('/stream/subscribe')||path.endsWith('/stream/unsubscribe')){assert.equal(JSON.parse(String(init?.body)).target_code,null);return Response.json({success:true});}
    if(path.includes('/data/contracts/'))return Response.json({security_type:'STK',region:'TW',exchange:'TSE',code:path.split('/')[5],name:'ISOLATED',category:'TEST',reference:30,limit_up:33,limit_down:27,trading_suspended:false,disposition_level:0,attention_flag:false,update_date:twDay(new Date())});
    if(/place_order|cancel_order/.test(path)){this.mutations++;throw new Error('Mutation forbidden');}
    throw new Error('Isolated endpoint is unavailable');
  };
}
const serviceFor=(f:StartupFixture,automaticLive=false)=>new TradingService(':memory:','live',(store,s,session)=>new ShioajiHttpBroker(store,s,true,f.fetch,session),{automaticLive});
async function until(predicate:()=>boolean){const deadline=Date.now()+7000;while(!predicate()){if(Date.now()>deadline)throw new Error('Recovery did not finish');await new Promise(r=>setTimeout(r,25));}}

test('mixed whole/odd holdings load without details and a failed bank read retains independent portfolio panels',async()=>{
  const f=new StartupFixture();f.balanceFails=true;const service=serviceFor(f);
  try{await service.start(false);const a=service.engine.account!;
    assert.equal(a.complete,false);assert.equal(a.available!.cash,false);assert.equal(a.available!.positions,true);
    assert.equal(a.positions[0]!.shares,1050);assert.equal(a.positions[0]!.sellable,1050);assert.equal(a.settlement_debits,'1200');
    assert.match(a.issue,/交割戶餘額.*503/);assert.ok(!f.paths.some(p=>p.endsWith('position_detail')));
    f.balanceFails=false;await service.engine.refreshAccount(new Date());assert.equal(service.engine.account!.complete,true);
    f.balanceFails=true;f.positions[0]!.last_price=32;await service.engine.refreshAccount(new Date());
    assert.equal(service.engine.account!.cash,'100000');assert.equal(service.engine.account!.positions[0]!.last_price,'32');
    assert.equal(service.engine.account!.complete,false);assert.ok(!service.engine.dataIssue.includes('PRIVATE_ACCOUNT_VALUE'));assert.equal(f.mutations,0);
  }finally{await service.close();}
});
test('failed trade reports still show bank balance and positions but never make unknown inventory sellable',async()=>{
  const f=new StartupFixture();f.reportsFail=true;const service=serviceFor(f,true);
  try{await service.start(false);const a=service.engine.account!;
    assert.equal(a.cash,'100000');assert.equal(a.available!.positions,true);assert.equal(a.positions[0]!.sellable,0);
    assert.match(a.issue,/委託核對.*503/);assert.equal(a.complete,false);assert.equal(service.liveAuthorized,false);assert.equal(f.mutations,0);
  }finally{await service.close();}
});
test('a balance with an older broker date is visible on first load while freshness continues to block live execution',async()=>{
  const f=new StartupFixture();f.balanceDay='2020-01-02';const service=serviceFor(f,true);
  try{await service.start(false);const a=service.engine.account!;
    assert.equal(a.cash,'100000');assert.equal(a.available!.cash,true);assert.equal(a.available!.positions,true);
    assert.equal(a.complete,false);assert.match(a.issue,/餘額日期尚未更新/);assert.equal(service.liveAuthorized,false);assert.equal(f.mutations,0);
  }finally{await service.close();}
});
test('selling old holdings then buying today cannot make the newly purchased shares day-tradable',async()=>{
  const f=new StartupFixture();f.positions[0]!.quantity=1100;f.positions[0]!.yd_quantity=1000;
  f.trades=[{contract:{security_type:'STK',exchange:'TSE',code:'9001'},order:{id:'isolated',action:'Buy',price:30,quantity:900,order_lot:'IntradayOdd',order_cond:'Cash',price_type:'LMT',order_type:'ROD',account:{account_type:'S',broker_id:'TEST',account_id:'ISOLATED'}},status:{status:'Filled',order_ts:Date.now()/1000,order_quantity:900,deal_quantity:900}}];
  const service=serviceFor(f);
  try{await service.start(false);assert.equal(service.engine.account!.complete,true);assert.equal(service.engine.account!.positions[0]!.sellable,200);assert.equal(f.mutations,0);}finally{await service.close();}
});
test('desktop live mode automatically becomes ready after recovery without enabling automation or undoing stop',async()=>{
  const f=new StartupFixture();f.balanceFails=true;const service=serviceFor(f,true);
  try{await service.saveSettings({...service.engine.settings,monitor_interval_seconds:1,auto_watchlist:false});await service.start(true);
    assert.equal(service.liveAuthorized,false);f.balanceFails=false;
    await until(()=>service.liveAuthorized);assert.equal(service.liveReadiness().ready,true);assert.equal(service.engine.settings.auto_execute,false);
    await service.command('stop');await service.command('continue');
    await new Promise(r=>setTimeout(r,1200));assert.equal(service.liveAuthorized,false);assert.equal(service.engine.settings.auto_execute,false);assert.equal(f.mutations,0);
  }finally{await service.close();}
});
test('a saved login survives encryption failures and blank credential fields reuse the same encrypted account',async()=>{
  const root=mkdtempSync(join(tmpdir(),'saved-login-'));let fail=false;
  const storage={isEncryptionAvailable:()=>true,encryptString:(s:string)=>{if(fail)throw new Error('PRIVATE_SECRET');return Buffer.from(Buffer.from(s).map(n=>n^42));},decryptString:(b:Buffer)=>Buffer.from(b.map(n=>n^42)).toString()};
  const input=ConnectionInputSchema.parse({api_key:'ISOLATED_KEY',secret_key:'ISOLATED_SECRET'});
  try{const vault=new CredentialVault(root,storage);await vault.save(input);const bytes=readFileSync(join(root,'connection.vault'));
    assert.equal((await new CredentialVault(root,storage).status()).state,'saved');
    const reused=connectionInput({api_key:'',secret_key:'',ca_path:'fixture.pfx',ca_password:'ISOLATED_CA'},await vault.read());
    assert.equal(reused.api_key,input.api_key);assert.equal(reused.ca_path,'fixture.pfx');
    assert.throws(()=>connectionInput({api_key:'NEW_KEY',secret_key:''},input));
    fail=true;await assert.rejects(vault.save({...input,api_key:'NEW_KEY'}),e=>e instanceof Error&&!e.message.includes('PRIVATE_SECRET'));
    assert.deepEqual(readFileSync(join(root,'connection.vault')),bytes);assert.equal((await vault.status()).remembered,true);
    writeFileSync(join(root,'connection.vault'),'unreadable');assert.equal((await vault.status()).state,'unreadable');
    assert.deepEqual(readdirSync(root),['connection.vault']);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('historical reads recover from transient 503 and refetch an old empty cache; 403 is attempted once',async()=>{
  const root=mkdtempSync(join(tmpdir(),'history-recovery-')),store=new Store(':memory:');let calls=0,status=503;
  const broker=new ShioajiHttpBroker(store,SettingsSchema.parse({}),false,async(_input,init)=>{
    calls++;if(status){const result=status;status=0;return Response.json({error:'PRIVATE_SECRET'},{status:result});}
    const contract=JSON.parse(String(init?.body)).contract;assert.equal(contract.region,'TW');assert.equal(contract.target_code,null);
    return Response.json({datetime:['2026-01-05T09:11:00','2026-01-05T09:10:00'],Open:[31,30],High:[32,31],Low:[30,29],Close:[31,30],Volume:[2,1]});
  });
  const load=()=>cachedHistory(broker,root,'9001','TSE','2026-01-05','2026-01-05','2026-01-06T00:00:00Z',new AbortController().signal);
  try{const points=await load();assert.equal(calls,2);assert.equal(points[0]!.at,'2026-01-05T01:10:00.000Z');assert.equal(points[0]!.volume_shares,1000);
    writeFileSync(join(root,readdirSync(root)[0]!),'[]');await load();assert.equal(calls,3);
    rmSync(root,{recursive:true,force:true});status=403;await assert.rejects(load(),/歷史 K 線.*403/);assert.equal(calls,4);
  }finally{await broker.close();store.close();rmSync(root,{recursive:true,force:true});}
});
test('Codex verifies the selected model once after login and keeps a failed probe visible across cached-auth checks',async()=>{
  const root=mkdtempSync(join(tmpdir(),'model-probe-'));let calls=0,reject=true;
  const settings=SettingsSchema.parse({codex_model:'isolated-model'});
  const login=new CodexLogin(root,async()=>undefined,async()=>undefined,{sourceProfile:join(root,'empty'),run:async()=>({}),settings:()=>settings,
    probe:async(s:Settings)=>{assert.equal(s.codex_model,settings.codex_model);calls++;return (async function*(){
      if(reject){yield {type:'item.completed',item:{id:'error',type:'error',message:'The model is not supported PRIVATE_SECRET'}} as ThreadEvent;return;}
      yield {type:'item.completed',item:{id:'answer',type:'agent_message',text:'{"ok":true}'}} as ThreadEvent;
      yield {type:'turn.completed',usage:{input_tokens:1,output_tokens:1,cached_input_tokens:0}} as ThreadEvent;
    })();}});
  try{assert.equal(await login.check(),true);await until(()=>login.status.test_state==='failed');
    assert.match(login.status.message,/模型不可用/);assert.ok(!login.status.message.includes('PRIVATE_SECRET'));
    await login.check();assert.equal(calls,1);assert.equal(login.status.test_state,'failed');assert.match(login.status.message,/模型不可用/);
    reject=false;await login.test(settings);assert.equal(login.status.test_state,'connected');assert.equal(calls,2);
    settings.codex_model='another-isolated-model';await login.check();await until(()=>calls===3&&!login.status.testing);
    assert.equal(login.status.test_state,'connected');assert.match(login.status.message,/another-isolated-model/);
  }finally{login.close();rmSync(root,{recursive:true,force:true});}
});
test('data failure before model invocation is identified beside Codex instead of being reported as an unexplained strategy failure',async()=>{
  const f=new StartupFixture(),service=serviceFor(f);
  try{await service.start(false);await service.saveSettings({...service.engine.settings,codex_enabled:true,auto_watchlist:false});
    service.broker.discover=async()=>{throw new BrokerError('Shioaji 歷史排行讀取失敗（HTTP 503）');};
    await assert.rejects(service.decide(),/本輪決策未啟用/);
    assert.match(service.analysisStatus,/歷史排行.*503/);assert.match(service.analystEvents.at(-1)!.message,/歷史排行.*503/);
    assert.equal(service.engine.plan,undefined);assert.equal(service.engine.entryBlocked,true);assert.equal(f.mutations,0);
  }finally{await service.close();}
});
