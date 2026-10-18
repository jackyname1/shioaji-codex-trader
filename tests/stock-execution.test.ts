import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stockOrderPayload} from '../src/broker/stock-order.js';
import {stockInstrumentKind} from '../src/core/stock-lot.js';
import {ShioajiHttpBroker} from '../src/broker/http.js';
import {LiveSession} from '../src/core/live-session.js';
import {Store} from '../src/core/store.js';
import {SettingsSchema,twDay,type Order} from '../src/core/models.js';
import {NoSubmissionError} from '../src/broker/types.js';
import {indicators} from '../src/core/strategy.js';
import {Risk} from '../src/core/risk.js';
import {TradingCalendar} from '../src/core/calendar.js';
import {account,instrument,now,order,quote,rig} from './helpers.js';

const selected={account_type:'S',broker_id:'TEST',account_id:'SYNTHETIC',signed:true};
test('legacy four-digit TDRs, preferred shares and ETFs are excluded from the ordinary-stock order boundary',()=>{
  assert.equal(stockInstrumentKind('9103','美德醫療-DR'),'OTHER');
  assert.equal(stockInstrumentKind('9105','泰金寶'),'OTHER');
  assert.equal(stockInstrumentKind('2891B','特別股'),'OTHER');
  assert.equal(stockInstrumentKind('0050','ETF'),'ETF');
  assert.equal(stockInstrumentKind('2330','台積電'),'STOCK');assert.equal(stockInstrumentKind('9914','美利達'),'STOCK');
  assert.throws(()=>stockOrderPayload(order({symbol:'9103',status:'SUBMITTING'}),{...instrument(),symbol:'9103',name:'美德醫療-DR'},selected),NoSubmissionError);
});
test('official HTTP payload is exact for TSE/OTC, both actions, and odd/common boundary quantities',()=>{
  for(const exchange of ['TSE','OTC'] as const)for(const action of ['BUY','SELL'] as const)
    for(const [lot,shares,quantity] of [['ODD',1,1],['ODD',999,999],['COMMON',1000,1],['COMMON',499000,499]] as const){
      const o=order({status:'SUBMITTING',action,lot,shares});
      assert.deepEqual(stockOrderPayload(o,{...instrument(),exchange},selected),{
        contract:{security_type:'STK',exchange,code:'9001'},stock_order:{action:action==='BUY'?'Buy':'Sell',price:30.05,
          quantity,price_type:'LMT',order_type:'ROD',order_lot:lot==='ODD'?'IntradayOdd':'Common',order_cond:'Cash',
          daytrade_short:false,custom_field:'abcdef',account:{broker_id:'TEST',account_id:'SYNTHETIC'}}});
    }
});
test('payload refuses wrong units, excessive quantity, fractional/zero size, replay, account and tick errors before transport',()=>{
  const valid=order({status:'SUBMITTING'});
  for(const bad of [{lot:'ODD',shares:1000},{lot:'COMMON',shares:999},{lot:'COMMON',shares:500000},
    {shares:0},{shares:1.1},{limit_price:'30.01'},{tag:'bad-11'},{filled:1},{broker_id:'already-sent'},
    {status:'PENDING'},{purpose:'EXTERNAL'}])
    assert.throws(()=>stockOrderPayload({...valid,...bad} as Order,instrument(),selected),NoSubmissionError);
  assert.throws(()=>stockOrderPayload(valid,instrument(),{...selected,signed:false}),NoSubmissionError);
  assert.throws(()=>stockOrderPayload(valid,{...instrument(),symbol:'9002'},selected),NoSubmissionError);
});

// Fully isolated HTTP transport. All responses, streaming and market/account data are synthetic.
async function fixture(flat=false){
  const store=new Store(':memory:'),session=new LiveSession(),writes:{path:string;body:any}[]=[];
  let handler:((path:string,body:any)=>Promise<Response>)|undefined;
  const native=(body:any,status='PendingSubmit',filled=0)=>({contract:body.contract,
    order:{...body.stock_order,id:'synthetic-trade',account:{...selected}},
    status:{status,order_ts:now.getTime()/1000,order_quantity:body.stock_order.quantity,deal_quantity:filled}});
  let trades:ReturnType<typeof native>[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const path=new URL(String(input)).pathname,body=init?.body?JSON.parse(String(init.body)):undefined;
    if(path.endsWith('/stream/data'))return new Response(new ReadableStream<Uint8Array>({start(c){
      c.enqueue(new TextEncoder().encode('event: heartbeat\ndata: {}\n\n'));
      init?.signal?.addEventListener('abort',()=>c.close(),{once:true});
    }}),{headers:{'Content-Type':'text/event-stream'}});
    if(path.endsWith('/info'))return Response.json({simulation:false,version:'1.7.8'});
    if(path.endsWith('/health'))return Response.json({status:'healthy',token_stale:false,token_expires_in_seconds:3600,ca_expired:false,ca_expires_in_days:30});
    if(path.endsWith('/auth/accounts'))return Response.json([selected]);
    if(path.endsWith('/order/trade_cache_health'))return Response.json({state:'Healthy',reasons:[]});
    if(path.endsWith('/order/trades'))return Response.json(trades);
    if(path.endsWith('/portfolio/account_balance'))return Response.json({acc_balance:1000000,date:twDay(now),errmsg:''});
    if(path.endsWith('/portfolio/position_unit'))return Response.json(flat?[]:[{id:1,code:'9001',direction:'Buy',cond:'Cash',quantity:10000,yd_quantity:10000,price:30,last_price:30}]);
    if(path.endsWith('/portfolio/settlements'))return Response.json([]);
    if(path.endsWith('/order/place_order')||path.endsWith('/order/cancel_order')){
      writes.push({path,body});return handler?handler(path,body):Response.json(native(body));
    }
    throw new Error('Unexpected isolated endpoint '+path);
  };
  class IsolatedBroker extends ShioajiHttpBroker {override async instruments(symbols:string[]){return Object.fromEntries(symbols.map(symbol=>[symbol,{...instrument(),symbol}]))}}
  const broker=new IsolatedBroker(store,SettingsSchema.parse({mode:'live',whole_lots:true}),true,fetcher,session,()=>now.getTime());
  await broker.connect();await broker.account(now);
  session.grant(store.get<string>('account_fingerprint')!);store.set('baseline_'+twDay(now),{equity:flat?'1000000':'1300000'});
  store.set('plan',{id:'test',created_at:now.toISOString(),analysis:{snapshot_id:'fixture',expires_at:new Date(now.getTime()+3600000).toISOString(),stance:'BUY_ALLOWED',candidates:['9001'],decisions:[],summary:'SYNTHETIC'}});
  const feed=()=>{for(const odd of [true,false])for(const event of ['tick_stk','bidask_stk'])broker.handleFrame({event,id:'',data:JSON.stringify({code:'9001',intraday_odd:odd,simtrade:false,
    date:twDay(now),time:'10:00:00',close:30,bid_price:[29.95],ask_price:[30.05],bid_volume:[10000],ask_volume:[10000]})});};feed();
  return {store,session,broker,writes,native,feed,setTrades:(t:typeof trades)=>{trades=t;},setHandler:(h:typeof handler)=>{handler=h;},
    close:async()=>{await broker.close();store.close();}};
}
test('real adapter sends one complete common/odd SELL payload and marks purchasing power dirty',async()=>{
  for(const [lot,shares] of [['ODD',999],['COMMON',2000]] as const){const f=await fixture();try{
    const o=order({action:'SELL',purpose:'EXIT',status:'SUBMITTING',lot,shares,limit_price:'29.95'});
    const result=await f.broker.submit(o);assert.equal(result.status,'SUBMITTING');
    assert.equal(f.writes.length,1);assert.equal(f.writes[0]!.body.stock_order.quantity,lot==='ODD'?999:2);
    assert.equal(f.broker.dirty,true);
    await assert.rejects(f.broker.submit({...o,local_id:'new-id',tag:'newtag'}),NoSubmissionError);assert.equal(f.writes.length,1);
  }finally{await f.close();}}
});
test('real adapter BUY path keeps price/account/TIF/lot/quantity exact for both markets',async()=>{
  for(const [lot,shares] of [['ODD',100],['COMMON',1000]] as const){const f=await fixture(true);try{
    const o=order({status:'SUBMITTING',lot,shares});await f.broker.submit(o);
    assert.deepEqual(f.writes[0]!.body,stockOrderPayload(o,instrument(),selected));assert.equal(f.writes.length,1);
  }finally{await f.close();}}
});
test('concurrent submission and account refresh cannot reuse a snapshot while a mutation is unresolved',async()=>{
  const f=await fixture();let release!:()=>void;const wait=new Promise<void>(r=>{release=r;});let started!:()=>void;const sending=new Promise<void>(r=>{started=r;});
  f.setHandler(async(_path,body)=>{started();await wait;return Response.json(f.native(body));});
  try{const o=order({action:'SELL',purpose:'EXIT',status:'SUBMITTING'}),first=f.broker.submit(o);await sending;
    await assert.rejects(f.broker.submit({...o,tag:'second'}),NoSubmissionError);
    await assert.rejects(f.broker.cancel({...o,broker_id:'synthetic-trade'}),NoSubmissionError);
    const snapshot=await f.broker.account(now);assert.equal(snapshot.complete,false);assert.equal(f.broker.dirty,true);
    release();await first;assert.equal(f.writes.length,1);assert.equal(f.broker.dirty,true);
  }finally{release();await f.close();}
});
test('accepted but disconnected response is never retried and recovers by tag after authoritative reconciliation',async()=>{
  const f=await fixture(),o=order({action:'SELL',purpose:'EXIT',status:'SUBMITTING'});
  try{f.setHandler(async(_path,body)=>{f.setTrades([f.native(body,'PartFilled',10)]);throw new Error('synthetic lost response');});
    await assert.rejects(f.broker.submit(o));assert.equal(f.writes.length,1);assert.equal(f.broker.dirty,true);
    const [recovered]=await f.broker.reconcile([{...o,status:'UNKNOWN'}],true);
    assert.equal(recovered!.status,'PARTIAL');assert.equal(recovered!.filled,10);assert.equal(f.writes.length,1);
  }finally{await f.close();}
});
test('mismatched broker account, exchange and filled state never become accepted terminal orders',async()=>{
  for(const change of ['account','exchange','filled']){const f=await fixture();try{
    f.setHandler(async(_path,body)=>{const t=f.native(body);if(change==='account')t.order.account.account_id='OTHER';
      if(change==='exchange')t.contract.exchange='OTC';if(change==='filled')t.status.status='Filled';return Response.json(t);});
    await assert.rejects(f.broker.submit(order({action:'SELL',purpose:'EXIT',status:'SUBMITTING'})));
    assert.equal(f.writes.length,1);assert.equal(f.broker.dirty,true);
  }finally{await f.close();}}
});
test('cancel retains fills that arrived before the request and waits for confirmed terminal status',async()=>{
  const f=await fixture(),o=order({action:'SELL',purpose:'EXIT',status:'PARTIAL',broker_id:'synthetic-trade',filled:5});
  const body=stockOrderPayload({...o,status:'SUBMITTING',broker_id:'',filled:0},instrument(),selected);
  try{f.setTrades([f.native(body,'PartFilled',10)]);
    f.setHandler(async()=>Response.json(f.native(body,'Submitted',10)));
    const cancelled=await f.broker.cancel(o);assert.equal(cancelled.status,'CANCEL_PENDING');assert.equal(cancelled.filled,10);
    f.setTrades([f.native(body,'Cancelled',17)]);const [done]=await f.broker.reconcile([cancelled],true);
    assert.equal(done!.status,'CANCELLED');assert.equal(done!.filled,17);assert.equal(f.writes.length,1);
  }finally{await f.close();}
});
test('no liquidity, oversize common and invalid counts fail deterministic risk before HTTP',()=>{
  const store=new Store(':memory:'),risk=new Risk(SettingsSchema.parse({whole_lots:true}),new TradingCalendar(store));
  try{assert.ok(risk.check(order(),account(),{...quote(),ask_shares:0},instrument(),now,'100000').some(r=>r.includes('深度')));
    for(const shares of [0,1.5,500000])assert.ok(risk.check(order({lot:'COMMON',shares}),account(),{...quote(),odd:false},instrument(),now,'100000').some(r=>r.includes('股數')||r.includes('499')));
  }finally{store.close();}
});
test('indicator inputs reject duplicate/reversed dates, invalid dates and prices outside OHLC',()=>{
  const bars=Array.from({length:30},(_,i)=>({date:new Date(Date.UTC(2026,8,i+1)).toISOString().slice(0,10),high:32,low:28,close:30,volume:1000}));
  assert.equal(indicators(bars).sufficient,true);
  for(const bad of [[...bars].reverse(),bars.map((b,i)=>i===5?{...b,date:bars[4]!.date}:b),
    bars.map((b,i)=>i===29?{...b,date:'2026-09-31'}:b),bars.map((b,i)=>i===5?{...b,close:35}:b)])assert.equal(indicators(bad).sufficient,false);
});
test('uncompleted/future history cannot become sufficient strategy inputs',async()=>{
  const r=await rig();try{
    for(const end of ['2026-10-08','2026-10-09']){
      r.market.history=async()=>Array.from({length:60},(_,i)=>({date:new Date(Date.parse(end)-(59-i)*86400000).toISOString().slice(0,10),high:32,low:28,close:30,volume:1000}));
      for(const c of (await r.market.discover(5,now)))r.store.delete(`history_v3_${twDay(now)}_PRE_${c.symbol}`);
      const bundle=await r.engine.collectBundle(now);
      assert.ok(Object.values(bundle.features).every(f=>!f.sufficient&&f.issue?.includes('未來交易日')));
    }
  }finally{await r.engine.close();r.store.close();}
});
