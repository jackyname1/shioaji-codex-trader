import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/core/store.js';
import { TradingService } from '../src/core/service.js';
import { CodexAnalyst, codexEnvironment, unpackedPath, bundledCodexPath, type Runner } from '../src/core/codex.js';
import { NoSubmissionError } from '../src/broker/types.js';
import { ShioajiHttpBroker, SseParser, exchangeTimestamp, sellableInventory } from '../src/broker/http.js';
import { demoAnalysis } from '../src/core/strategy.js';
import { SettingsSchema, type Order } from '../src/core/models.js';
import { type ThreadEvent } from '@openai/codex-sdk';
import { rig, now, quote, settings, order, snapshot, instrument } from './helpers.js';

test('end-to-end odd-lot partial fill: 17 + 13 shares, fee once, no same-event double fill',async () => {
  const r = await rig();
  try {
    await r.engine.tick(now); assert.equal(r.store.orders().length,1); assert.equal(r.store.orders()[0]!.filled,0);
    const tick = new Date(now.getTime()+1000); await r.engine.tick(tick);
    assert.equal(r.store.orders()[0]!.filled,17); assert.equal(r.store.orders()[0]!.status,'PARTIAL');
    await r.engine.tick(tick); assert.equal(r.store.orders()[0]!.filled,17);
    await r.engine.tick(new Date(now.getTime()+2000)); assert.equal(r.store.orders()[0]!.status,'FILLED');
    assert.equal(r.engine.account!.positions[0]!.sellable,0);
    assert.equal(r.engine.account!.cash,'99078.5'); // 30 * 30.05 + one NT$20 fee
    for (let n = 3;n<10;n++) await r.engine.tick(new Date(now.getTime()+n*1000));
    assert.equal(r.store.orders().length,1);
  } finally { await r.engine.close(); r.store.close(); }
});
test('smart stop waits on today inventory and sells only on the next eligible session',async () => {
  const r = await rig();
  try {
    for (let n=0;n<3;n++) await r.engine.tick(new Date(now.getTime()+n*1000));
    r.market.marketPrice='28'; await r.engine.tick(new Date(now.getTime()+3000));
    assert.equal(r.store.orders().filter(o => o.action === 'SELL').length,0);
    assert.ok(r.store.protections()[0]!.triggered);
    const monday = new Date('2026-10-12T10:00:00+08:00'); await r.engine.tick(monday);
    const sells = r.store.orders().filter(o => o.action === 'SELL'); assert.equal(sells.length,1);
    assert.equal(sells[0]!.shares,30); assert.equal(sells[0]!.purpose,'PROTECTION');
  } finally { await r.engine.close(); r.store.close(); }
});
test('kill prevents every new order while pause only prevents buys',async () => {
  const r = await rig();
  try { r.engine.kill(); await r.engine.tick(now); assert.equal(r.store.orders().length,0);
    r.engine.kill(false); r.engine.pauseEntries(); await r.engine.tick(new Date(now.getTime()+1000));
    assert.equal(r.store.orders().length,0); r.engine.pauseEntries(false);
    await r.engine.tick(new Date(now.getTime()+2000)); assert.equal(r.store.orders().length,1);
  } finally { await r.engine.close(); r.store.close(); }
});
test('uncertain network result is persisted UNKNOWN and reconciled without resend',async () => {
  const r = await rig(), submit = r.broker.submit.bind(r.broker); let sends=0;
  r.broker.submit = async o => { sends++; await submit(o); throw new Error('connection lost after acceptance'); };
  try { await r.engine.tick(now); assert.equal(r.store.orders()[0]!.status,'UNKNOWN');
    for (let n=1;n<6;n++) await r.engine.tick(new Date(now.getTime()+n*1000));
    assert.equal(sends,1); assert.equal(r.store.orders()[0]!.status,'FILLED');
  } finally { await r.engine.close(); r.store.close(); }
});
test('a preflight refusal is marked rejected, never misreported as an uncertain network send',async () => {
  const r = await rig();
  r.broker.submit = async () => { throw new NoSubmissionError('官方服務需要可信任主機能力票證'); };
  try { await r.engine.tick(now); assert.equal(r.store.orders()[0]!.status,'REJECTED');
    assert.ok(r.engine.entryBlocked); assert.ok(r.store.logs().some(x => x.includes('未送出委託')));
  } finally { await r.engine.close(); r.store.close(); }
});
test('expiry cancels an entry remainder and retains independent protection',async () => {
  const r = await rig();
  try { await r.engine.tick(now); await r.engine.tick(new Date(now.getTime()+1000));
    r.engine.plan!.lifecycle='TIMED';r.engine.plan!.analysis.expires_at=new Date(now.getTime()+1500).toISOString(); r.market.depth=0;
    await r.engine.tick(new Date(now.getTime()+2000)); assert.equal(r.store.orders()[0]!.status,'CANCELLED');
    assert.equal(r.store.orders()[0]!.filled,17); assert.equal(r.store.protections().length,1);
  } finally { await r.engine.close(); r.store.close(); }
});
test('SQLite restart restores partial fills, plan, cash and smart protection',async () => {
  const dir=mkdtempSync(join(tmpdir(),'shioaji-restart-')),path=join(dir,'demo.db');
  let r = await rig(new Store(path));
  try {
    await r.engine.tick(now); await r.engine.tick(new Date(now.getTime()+1000)); const id=r.store.orders()[0]!.local_id;
    await r.engine.close(); r.store.close();
    const { TradingCalendar }=await import('../src/core/calendar.js'), { Engine }=await import('../src/core/engine.js');
    const { PaperBroker }=await import('../src/broker/paper.js'); const { ControlledMarket }=await import('./helpers.js');
    const store=new Store(path),calendar=new TradingCalendar(store,true),market=new ControlledMarket();
    const broker=new PaperBroker(store,market,settings(),calendar),engine=new Engine(store,broker,settings(),calendar);
    r={...r,store,calendar,market,broker,engine}; await engine.start(new Date(now.getTime()+2000));
    assert.equal(store.orders()[0]!.local_id,id); assert.equal(store.orders()[0]!.filled,17); assert.equal(store.protections().length,1);
    await engine.tick(new Date(now.getTime()+3000)); assert.equal(store.orders().length,1); assert.equal(store.orders()[0]!.filled,30);
  } finally { await r.engine.close(); r.store.close(); rmSync(dir,{recursive:true,force:true}); }
});
test('inventory detail units are verified and today/future acquisition never sells',() => {
  const row = (date:string,quantity:number) => ({date,quantity,direction:'Buy',cond:'Cash'});
  assert.equal(sellableInventory(30,20,[row('2026-10-07',20),row('2026-10-08',10)],'2026-10-08'),20);
  assert.equal(sellableInventory(1000,1000,[row('2026-10-07',1)],'2026-10-08'),1000);
  assert.throws(() => sellableInventory(30,20,[row('2026-10-07',2)],'2026-10-08'));
  assert.throws(() => sellableInventory(30,30,[row('2026-10-09',30)],'2026-10-08'));
});
test('SSE parser handles arbitrary chunking, CRLF, multiple data fields and Taiwan timestamps',() => {
  const p = new SseParser(); assert.deepEqual(p.push('event: tick_stk\r\n'),[]);
  assert.deepEqual(p.push('id: abc\r\ndata: a\r\ndata: b\r\n\r'),[]);
  assert.deepEqual(p.push('\n'),[{event:'tick_stk',id:'abc',data:'a\nb'}]);
  assert.equal(exchangeTimestamp({date:'2026-10-08',time:'10:00:00.123456'}),'2026-10-08T02:00:00.123Z');
  assert.equal(exchangeTimestamp({date:[2026,10,8],time:[10,0,0,123456]}),'2026-10-08T02:00:00.123Z');
});
test('odd quotes are distinct from common-lot quotes and gap invalidates both',() => {
  const store=new Store(':memory:'),broker=new ShioajiHttpBroker(store,SettingsSchema.parse({mode:'readonly'}));
  const frame=(event:string,odd:boolean) => ({event,id:'',data:JSON.stringify({code:'9001',intraday_odd:odd,simtrade:false,
    date:'2026-10-08',time:'10:00:00',close:'30',bid_price:['29.95'],ask_price:['30.05'],bid_volume:[17],ask_volume:[17]})});
  broker.handleFrame(frame('tick_stk',true)); broker.handleFrame(frame('bidask_stk',true));
  broker.handleFrame(frame('tick_stk',false)); broker.handleFrame(frame('bidask_stk',false));
  const qs=broker.quotes(now); assert.equal(qs.length,2); assert.equal(qs.find(q => !q.odd)!.bid_shares,17000);
  broker.handleFrame({event:'derived_gap',id:'',data:'{}'}); assert.deepEqual(broker.quotes(now),[]); assert.equal(broker.generation,1); store.close();
});
test('HTTP transport enforces loopback and submits a read-only request only once',async () => {
  const store=new Store(':memory:'); assert.throws(() => new ShioajiHttpBroker(store,SettingsSchema.parse({base_url:'http://example.com'})));
  let calls=0; const fake: typeof fetch = async () => { calls++; throw new Error('timeout'); };
  const broker=new ShioajiHttpBroker(store,SettingsSchema.parse({mode:'readonly'}),false,fake);
  await assert.rejects(broker.request('/health')); assert.equal(calls,1); await broker.close(); store.close();
});
test('native order normalization checks identity, units, cumulative fills and pending cancel',() => {
  const store=new Store(':memory:'),broker=new ShioajiHttpBroker(store,SettingsSchema.parse({mode:'readonly'}));
  const local=order({broker_id:'broker',filled:10,status:'CANCEL_PENDING'});
  const trade={contract:{code:'9001',security_type:'STK' as const,exchange:'TSE'},order:{id:'broker',action:'Buy' as const,
    price:'30.05',quantity:30,order_lot:'IntradayOdd',order_cond:'Cash',price_type:'LMT',order_type:'ROD',custom_field:'abcdef',
    account:{account_type:'S',broker_id:'test',account_id:'test',signed:true}},
    status:{status:'PartFilled',order_ts:now.getTime()/1000,order_quantity:30,deal_quantity:17}};
  assert.equal(broker.normalizeTrade(trade,local).status,'CANCEL_PENDING');
  assert.equal(broker.normalizeTrade({...trade,status:{...trade.status,modified_price:'0'}},local).limit_price,'30.05');
  assert.throws(() => broker.normalizeTrade({...trade,status:{...trade.status,deal_quantity:9}},local));
  assert.throws(() => broker.normalizeTrade({...trade,order:{...trade.order,price:'30.1'}},local));
  assert.equal(broker.normalizeTrade({...trade,order:{...trade.order,order_lot:'Common',quantity:1},
    status:{...trade.status,status:'Submitted',order_quantity:1,deal_quantity:0}}).shares,1000); store.close();
});
test('native subscriptions rotate only app-requested keys, retain requested inventory and enforce a bounded shared mode',async () => {
  const store=new Store(':memory:'),calls:{path:string;body:Record<string,unknown>}[]=[];
  const fake:typeof fetch=async(input,init)=>{calls.push({path:new URL(String(input)).pathname,body:JSON.parse(String(init?.body))});return Response.json({success:true});};
  class Quotes extends ShioajiHttpBroker {
    override async instruments(symbols:string[],at:Date){return Object.fromEntries(symbols.map(symbol=>[symbol,{...instrument(at),symbol}]));}
  }
  const broker=new Quotes(store,SettingsSchema.parse({mode:'readonly'}),false,fake);
  try {
    await broker.subscribe(['9001','9002'],false);assert.equal(calls.length,4);
    await broker.subscribe(['9001','9003'],false);
    const removed=calls.filter(c=>c.path.endsWith('/unsubscribe'));assert.equal(removed.length,2);
    assert.ok(removed.every(c=>c.body.code==='9002'));
    broker.handleFrame({event:'derived_gap',id:'',data:'{}'});
    const before=calls.length;await broker.subscribe(['9001','9003'],false);assert.equal(calls.length-before,4);
    broker.settings=SettingsSchema.parse({mode:'readonly',manage_quote_subscriptions:false});
    const removedBefore=calls.filter(c=>c.path.endsWith('/unsubscribe')).length;
    await broker.subscribe(['9004'],false);assert.equal(calls.filter(c=>c.path.endsWith('/unsubscribe')).length,removedBefore);
    const beforeLimit=calls.length;
    await assert.rejects(broker.subscribe(Array.from({length:80},(_,i)=>String(9100+i)),false),/160/);
    assert.equal(calls.length,beforeLimit);
  } finally {await broker.close();store.close();}
});
test('native trade reconciliation reads callbacks from cache and forces authoritative sync before mutations or after a gap',async () => {
  const store=new Store(':memory:'),modes:boolean[]=[];
  const fake:typeof fetch=async(input,init)=>{
    const path=new URL(String(input)).pathname;
    if(path.endsWith('/stream/data'))return new Response(new ReadableStream<Uint8Array>({start(controller){
      controller.enqueue(new TextEncoder().encode('event: heartbeat\ndata: {}\n\n'));
      init?.signal?.addEventListener('abort',()=>controller.close(),{once:true});
    }}),{headers:{'Content-Type':'text/event-stream'}});
    if(path.endsWith('/info'))return Response.json({simulation:false,version:'1.7.6'});
    if(path.endsWith('/health'))return Response.json({status:'healthy'});
    if(path.endsWith('/auth/accounts'))return Response.json([{account_type:'S',broker_id:'TEST',account_id:'SYNTHETIC',signed:true}]);
    if(path.endsWith('/auth/subscribe_trade'))return Response.json({subscribe_trade:true});
    if(path.endsWith('/openapi.json'))return Response.json({paths:Object.fromEntries([
      '/api/v1/order/trades','/api/v1/order/trade_cache_health','/api/v1/portfolio/position_unit','/api/v1/portfolio/position_detail',
      '/api/v1/stream/data','/api/v1/data/contracts/{code}/info'].map(p=>[p,{}]))});
    if(path.endsWith('/order/trade_cache_health'))return Response.json({state:'Healthy',reasons:[]});
    if(path.endsWith('/order/trades')){modes.push(JSON.parse(String(init?.body)).refresh);return Response.json([]);}
    throw new Error('Unexpected mock endpoint');
  };
  const broker=new ShioajiHttpBroker(store,SettingsSchema.parse({mode:'readonly'}),false,fake);
  try {
    await broker.connect();await broker.reconcile([]);await broker.reconcile([]);assert.equal(modes.at(-1),false);
    await broker.reconcile([],true);assert.equal(modes.at(-1),true);
    broker.handleFrame({event:'derived_gap',id:'',data:'{}'});await broker.reconcile([]);assert.equal(modes.at(-1),true);
    await broker.reconcile([order({status:'UNKNOWN'})]);assert.equal(modes.at(-1),true);
  } finally {await broker.close();store.close();}
});
test('Codex environment removes broker keys, CA, runtime grants and trading flags',() => {
  const env=codexEnvironment({PATH:'path',SJ_API_KEY:'SECRET',SJ_SEC_KEY:'SECRET',SJ_CA_PATH:'SECRET',
    SJ_AGENT_HARNESS_BROKER_TOKEN:'SECRET',LIVE_TRADING:'true',CODEX_HOME:'old'},'/isolated/codex');
  assert.deepEqual(env,{PATH:'path',CODEX_HOME:'/isolated/codex'});
});
test('bundled Codex resolves an executable outside Electron ASAR on each platform',() => {
  assert.equal(unpackedPath('/a/app.asar/node_modules/codex'),'/a/app.asar.unpacked/node_modules/codex');
  assert.equal(unpackedPath('C:\\a\\app.asar\\node_modules\\codex'),'C:\\a\\app.asar.unpacked\\node_modules\\codex');
  assert.match(bundledCodexPath(),/codex(?:\.exe)?$/);
});
test('Codex SDK stream accepts schema-valid completed output, rejects tools and incomplete responses',async () => {
  const input=snapshot(), a=demoAnalysis(input,settings(),now), s=SettingsSchema.parse({codex_enabled:true});
  const runner=(events:ThreadEvent[]): Runner => async () => ({events:(async function*(){yield* events;})()});
  const completed:ThreadEvent[]=[{type:'item.completed',item:{type:'agent_message',id:'message',text:JSON.stringify(a)}},
    {type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1,cache_write_input_tokens:0,reasoning_output_tokens:0}}];
  const analyst=new CodexAnalyst(s,'/unused',runner(completed)); assert.deepEqual(await analyst.analyze(input),a);
  await assert.rejects(new CodexAnalyst(s,'/unused',runner([{type:'item.started',item:{type:'command_execution',id:'tool',command:'forbidden',aggregated_output:'',status:'in_progress'}}])).analyze(input));
  await assert.rejects(new CodexAnalyst(s,'/unused',runner(completed.slice(0,1))).analyze(input));
});
test('service modes use independent databases and live settings cannot enable trading implicitly',async () => {
  const dir=mkdtempSync(join(tmpdir(),'shioaji-service-')),path=join(dir,'demo.db');
  const service=new TradingService(path,'demo');
  try { await service.start(false); await assert.rejects(service.saveSettings({...service.engine.settings,mode:'live',auto_execute:true}));
    await service.command('stop'); assert.ok(service.engine.killed); await service.command('continue');
    await service.command('auto on'); assert.ok(service.engine.settings.auto_execute);
  } finally { await service.close(); }
  assert.throws(() => new TradingService(path,'readonly'),/獨立資料庫/); rmSync(dir,{recursive:true,force:true});
});
