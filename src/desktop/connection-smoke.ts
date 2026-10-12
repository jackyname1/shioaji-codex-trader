import {EventEmitter} from 'node:events';
import type {spawn} from 'node:child_process';
import {NativeConnection} from './credentials.js';
import {ShioajiHttpBroker} from '../broker/http.js';
import {BrokerError} from '../broker/health.js';
import {twDay} from '../core/models.js';
import type {TradingService} from '../core/service.js';

/** Used only by --smoke-test. Every request and process is isolated; live mutations are rejected. */
export class ConnectionSmoke {
  simulation=false;failWorkspace=false;launches=0;mutations=0;
  native(root:string):NativeConnection{return new NativeConnection(root,async()=>'/SYNTHETIC/native',{
    origin:async()=>'http://127.0.0.1:19099',run:async()=>({stdout:'--no-open --production'}),
    launch:((_:string,args:readonly string[])=>{if(!args.includes('--production'))throw new Error('Production market flag is missing');this.launches++;
      const child=new EventEmitter() as EventEmitter&{exitCode:number|null;kill:()=>boolean};child.exitCode=null;
      child.kill=()=>{child.exitCode=0;setImmediate(()=>child.emit('exit'));return true;};return child;}) as unknown as typeof spawn,
    fetcher:this.fetch,timeoutMs:1000,pollMs:10,
  });}
  market:ConstructorParameters<typeof TradingService>[2]=(store,settings,session)=>{
    if(this.failWorkspace)throw new BrokerError('交易工作台隔離測試載入失敗');
    return new ShioajiHttpBroker(store,settings,false,this.fetch,session);
  };
  reader:ConstructorParameters<typeof TradingService>[2]=(store,settings,session)=>new ShioajiHttpBroker(store,settings,false,this.fetch,session);
  fetch:typeof fetch=async(input,init)=>{
    const path=new URL(String(input)).pathname;
    if(/place_order|cancel_order/.test(path)){this.mutations++;throw new Error('Real mutations forbidden');}
    if(path==='/api/v1/info')return Response.json({simulation:this.simulation,version:'1.7.7'});
    if(path==='/api/v1/health')return Response.json({status:'healthy',token_stale:false,token_expires_in_seconds:3600,ca_expired:false,ca_expires_in_days:30});
    if(path.endsWith('/auth/accounts'))return Response.json([{account_type:'S',broker_id:'SYNTHETIC',account_id:'SYNTHETIC_ACCOUNT',signed:true}]);
    if(path.endsWith('/stream/data'))return new Response(new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('event: heartbeat\ndata: {}\n\n'));init?.signal?.addEventListener('abort',()=>{try{c.close();}catch{}},{once:true});}}),{headers:{'content-type':'text/event-stream'}});
    if(path.endsWith('/order/trade_cache_health'))return Response.json({state:'Healthy',reasons:[]});
    if(path.endsWith('/order/trades'))return Response.json([]);
    if(path.endsWith('/auth/subscribe_trade'))return Response.json({subscribe_trade:true});
    if(path.endsWith('/portfolio/account_balance'))return Response.json({acc_balance:100000,date:twDay(new Date())+' 10:00:00',errmsg:''});
    if(path.endsWith('/portfolio/settlements')||path.endsWith('/portfolio/position_unit'))return Response.json([]);
    if(path.endsWith('/stream/subscribe')||path.endsWith('/stream/unsubscribe'))return Response.json({success:true});
    if(path.includes('/data/contracts/'))return Response.json({security_type:'STK',region:'TW',exchange:'TSE',code:path.split('/').at(-2),name:'隔離測試',category:'TEST',reference:30,limit_up:33,limit_down:27,trading_suspended:false,disposition_level:0,attention_flag:false,update_date:twDay(new Date())});
    throw new BrokerError('隔離連線測試未提供此端點');
  };
}
