import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BacktestRequestSchema,runBacktest,fillsCsv } from '../src/core/backtest.js';
import { syntheticDataset,csvDataset,HistoricalMarket,validateDataset,type HistoryDataset } from '../src/core/backtest-data.js';
import { historicalKbars } from '../src/broker/historical-format.js';
import { SettingsSchema,d,twDay,type Analysis,type Snapshot } from '../src/core/models.js';
import { roundPrice,tickSize } from '../src/core/risk.js';
import { Store } from '../src/core/store.js';
import { experienceContext } from '../src/core/experience.js';
import { analysisPrompt } from '../src/core/codex.js';
import { BacktestController } from '../src/core/backtest-controller.js';
import { shioajiDataset } from '../src/core/backtest-source.js';
import { rig,now,testSize } from './helpers.js';

const start='2026-01-05',end='2026-01-09';
const options=(whole_lots=false)=>({start,end,source:'sample',strategy:'demo',initial_cash:whole_lots?'1000000':'100000',whole_lots});
function flatDataset():HistoryDataset {
  const dataset=syntheticDataset(start,end);
  for(const p of dataset.points){p.open=p.close=p.high=p.low='30';p.volume_shares=1000000;}
  return dataset;
}
function response(s:Snapshot,action:'BUY'|'SELL'|'HOLD'='HOLD',shares=100):Analysis {
  const price=d(s.universe.find(x=>x.symbol==='9001')?.last??'30');
  return {snapshot_id:s.snapshot_id,expires_at:new Date(Date.parse(s.asof)+7200000).toISOString(),
    stance:action==='BUY'?'BUY_ALLOWED':'HOLD_ONLY',candidates:s.universe.slice(0,5).map(x=>x.symbol),
    decisions:action==='HOLD'?[]:[{symbol:'9001',action,shares,limit_price:roundPrice(price.times(action==='BUY'?'1.01':'.99'),action!=='BUY'),
      entry_when:'IMMEDIATE',trigger_price:'0',reason:'測試替身，不是真實 Codex 決策',
      smart:action==='BUY'?{stop_price:'29',take_profit:'36',trailing_activate:null,trailing_fraction:null}:null}],summary:'測試替身檢討：費用與風控'};
}
test('historical request validates real dates, chronological ranges and separate demo strategy',()=>{
  assert.throws(()=>BacktestRequestSchema.parse({...options(),start:'2026-02-30'}));
  assert.throws(()=>BacktestRequestSchema.parse({...options(),end:'2025-01-01'}));
  assert.throws(()=>BacktestRequestSchema.parse({...options(),source:'csv'}));
  assert.throws(()=>BacktestRequestSchema.parse({...options(),initial_cash:'NaN'}));
  assert.equal(BacktestRequestSchema.parse(options()).participation,'0.01');
});
test('CSV removes equivalent duplicate bars and rejects conflicting bars, ambiguous time, wrong OHLC and unsupported securities',()=>{
  const header='symbol,at,open,high,low,close,volume_shares\n',row='9001,2026-01-05T09:10:00+08:00,30,31,29,30,1000\n';
  assert.equal(csvDataset(header+row).points[0]!.volume_shares,1000);
  assert.equal(csvDataset(header+row+row).points.length,1);assert.equal(csvDataset(header+row+row).normalization!.duplicates,1);
  assert.throws(()=>csvDataset(header+row+row.replace(',1000',',2000')),/價格或成交量不一致/);
  assert.throws(()=>csvDataset(header+row.replace('+08:00','')));
  assert.throws(()=>csvDataset(header+row.replace(',31,29,',',28,29,')));
  assert.throws(()=>csvDataset(header+row.replace('9001','0050')));
});
test('HTTP Kbars accepts current ISO datetime and legacy nanoseconds, converting stock lots to shares',()=>{
  const base={Open:['30'],High:['31'],Low:['29'],Close:['30.5'],Volume:[17]};
  const p=historicalKbars({...base,datetime:['2026-01-05T09:01:00']},'9001')[0]!;
  assert.equal(p.at,'2026-01-05T01:01:00.000Z');assert.equal(p.volume_shares,17000);
  assert.equal(historicalKbars({...base,ts:[String(BigInt(Date.parse(p.at))*1000000n)]},'9001')[0]!.at,p.at);
  assert.throws(()=>historicalKbars({...base,High:[],datetime:['2026-01-05T09:01:00']},'9001'));
});
test('historical features, dynamic rankings and quotes exclude future data at the same virtual cutoff',async()=>{
  const data=flatDataset(),at=new Date(start+'T09:10:00+08:00'),changed=structuredClone(data);
  for(const p of changed.points)if(Date.parse(p.at)>at.getTime()){p.open=p.high=p.low=p.close='300';p.volume_shares=99999999;}
  const a=new HistoricalMarket(data,'0.01'),b=new HistoricalMarket(validateDataset(changed),'0.01');
  await a.subscribe(['9001'],true);await b.subscribe(['9001'],true);
  assert.deepEqual(await a.history('9001',at),await b.history('9001',at));
  assert.deepEqual(await a.discover(20,at),await b.discover(20,at));assert.deepEqual(a.quotes(at),b.quotes(at));
  assert.ok((await a.history('9001',at)).every(x=>x.date<start));
  assert.equal(a.quotes(new Date(at.getTime()+1000)).length,0);
});
test('daily CSV reveals open at the simulated start and close only at 13:30, using prior volume',async()=>{
  const data=csvDataset('symbol,date,open,high,low,close,volume_shares\n9001,2026-01-02,29,30,28,29,270000\n9001,2026-01-05,30,35,25,33,99999999');
  const market=new HistoricalMarket(data,'0.01');await market.subscribe(['9001'],false);
  const q=market.quotes(new Date(start+'T09:10:00+08:00'))[0]!;
  assert.equal(q.last,'30');assert.equal(q.ask_shares,10);
  assert.equal(market.quotes(new Date(start+'T13:30:00+08:00'))[0]!.last,'33');
  assert.equal((await market.history('9001',new Date(start+'T12:00:00+08:00'))).at(-1)!.close,29);
});
test('backtest reuses the trading engine, accounts for costs and reconciles realized plus unrealized PnL',async()=>{
  const r=await runBacktest(options(),flatDataset(),SettingsSchema.parse({}),undefined,new AbortController().signal);
  assert.equal(r.status,'COMPLETED');assert.equal(r.metrics.codex_calls,0);assert.ok(r.metrics.filled_orders>0);
  assert.ok(d(r.metrics.fees).gt(0));assert.ok(d(r.metrics.net_pnl).eq(d(r.metrics.realized_pnl).plus(r.metrics.unrealized_pnl)));
  assert.ok(d(r.metrics.final_equity).eq(d(r.metrics.initial_cash).plus(r.metrics.net_pnl)));
  assert.ok(r.fills.every(f=>f.lot==='ODD'&&f.shares<=999));assert.equal(r.daily_equity.length,5);
  assert.ok(r.reviews.length>0);assert.match(fillsCsv(r),/realized_pnl/);
});
test('Codex replay receives bounded experience, no current facts, and fills after submission only',async()=>{
  const snapshots:Snapshot[]=[],dataset=flatDataset();
  const r=await runBacktest({...options(),strategy:'codex'},dataset,SettingsSchema.parse({codex_enabled:true}),async s=>{
    snapshots.push(structuredClone(s));const position=s.account.positions.find(x=>x.symbol==='9001');
    return response(s,s.review_only?'HOLD':!position?'BUY':position.sellable?'SELL':'HOLD');
  },new AbortController().signal,undefined,undefined,undefined,undefined,testSize);
  assert.ok(r.metrics.codex_calls>0);assert.ok(r.fills.some(f=>f.action==='SELL'));assert.ok(d(r.metrics.taxes).gt(0));
  assert.ok(d(r.metrics.net_pnl).eq(d(r.metrics.realized_pnl).plus(r.metrics.unrealized_pnl)));
  for(const f of r.fills){const o=r.orders.find(o=>o.local_id===f.order_id)!;assert.ok(Date.parse(f.at)>Date.parse(o.created_at));}
  const firstBuy=r.fills.find(f=>f.action==='BUY')!,firstSell=r.fills.find(f=>f.action==='SELL')!;
  assert.ok(twDay(new Date(firstSell.at))>twDay(new Date(firstBuy.at)));
  assert.ok(snapshots.some(s=>s.experience!.observations.length>0));
  for(const s of snapshots){assert.deepEqual(s.news,[]);assert.deepEqual(s.fundamentals,{});
    assert.ok(s.experience!.observations.every(x=>Date.parse(x.at)<=Date.parse(s.asof)));
    assert.ok(s.experience!.reviews.every(x=>Date.parse(x.at)<=Date.parse(s.asof)));}
  assert.match(analysisPrompt(snapshots[0]!),/不得引用之後/);
});
test('whole-lot entries and protective exits use common lots instead of splitting into 999-share chunks',async()=>{
  const dataset=flatDataset();for(const p of dataset.points)if(twDay(new Date(p.at))==='2026-01-06')p.open=p.close=p.low=p.high='28.5';
  const r=await runBacktest({...options(true),strategy:'codex'},dataset,SettingsSchema.parse({codex_enabled:true}),async s=>{
    return response(s,!s.review_only&&twDay(new Date(s.asof))===start&&!s.account.positions.length?'BUY':'HOLD',2000);
  },new AbortController().signal,undefined,undefined,undefined,undefined,testSize);
  assert.ok(r.fills.some(f=>f.action==='BUY'&&f.lot==='COMMON'&&f.shares===2000));
  assert.ok(r.fills.some(f=>f.purpose==='PROTECTION'&&f.lot==='COMMON'&&f.shares===2000));
  assert.ok(r.metrics.max_drawdown_pct!=='0.0000');
});
test('experience retrieval excludes other modes and later outcomes and survives SQLite reopening',()=>{
  const dir=mkdtempSync(join(tmpdir(),'experience-test-')),path=join(dir,'state.db');let store=new Store(path);
  try {for(const [id,at,mode] of [['a','2026-01-05T10:00:00+08:00','paper'],['b','2026-01-06T10:00:00+08:00','paper'],['c','2026-01-05T10:00:00+08:00','live']])
    store.recordExperience({id:id!,at:at!,mode:mode!,kind:'SIMULATED_FILL',symbol:'9001',action:'SELL',shares:10,price:'30',fee:'20',tax:'1',realized_pnl:'-21',note:'test'});
    store.close();store=new Store(path);const c=experienceContext(store,SettingsSchema.parse({mode:'paper'}),'2026-01-05T14:00:00+08:00');
    assert.equal(c.sample_count,1);assert.equal(c.realized_pnl,'-21');assert.ok(!JSON.stringify(c).includes('"id"'));
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('failed Codex replay reports FAILED without claiming zero-profit performance as a valid strategy test',async()=>{
  const r=await runBacktest({...options(),strategy:'codex',max_codex_calls:2},flatDataset(),SettingsSchema.parse({codex_enabled:true}),
    async()=>{throw new Error('mock invalid output');},new AbortController().signal);
  assert.equal(r.status,'FAILED');assert.equal(r.metrics.codex_calls,2);assert.equal(r.fills.length,0);
  assert.ok(r.limitations.some(x=>x.includes('沒有任何有效 Codex')));
});
test('cancel stops future decisions while preserving partial simulation and one equity row per session',async()=>{
  const abort=new AbortController();let calls=0;
  const r=await runBacktest({...options(),strategy:'codex'},flatDataset(),SettingsSchema.parse({codex_enabled:true}),async s=>{
    if(++calls===2)abort.abort();return response(s,'BUY');
  },abort.signal);
  assert.equal(r.status,'CANCELLED');assert.equal(calls,2);assert.equal(new Set(r.daily_equity.map(x=>x.day)).size,r.daily_equity.length);
  assert.equal(r.daily_equity.at(-1)!.complete,false);assert.equal(r.daily_equity.at(-1)!.asof,r.asof);
});
test('expired paper entry is cancelled before a new price event can fill it',async()=>{
  const r=await rig();try{await r.engine.tick(now);r.engine.plan!.analysis.expires_at=new Date(now.getTime()+500).toISOString();
    await r.engine.tick(new Date(now.getTime()+1000));assert.equal(r.store.orders()[0]!.filled,0);assert.equal(r.store.orders()[0]!.status,'CANCELLED');
  }finally{await r.engine.close();r.store.close();}
});
test('controller saves and restores a download-test report without broker or Codex login',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'backtest-controller-'));try{
    const c=new BacktestController(dir);c.start(options(),SettingsSchema.parse({}));await c.wait();
    assert.equal(c.progress.phase,'COMPLETED');assert.ok(c.report);
    const next=new BacktestController(dir);await next.restore();assert.equal(next.report!.id,c.report.id);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('historical Shioaji loader queries only past ranking, contracts and bars; cache avoids repeat history requests',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'historical-readonly-')),calls:{path:string;body:Record<string,unknown>}[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const path=new URL(String(input)).pathname,body=init?.body?JSON.parse(String(init.body)) as Record<string,unknown>:{};
    calls.push({path,body});let result:unknown;
    if(path==='/api/v1/info')result={simulation:false};
    else if(path.endsWith('/health'))result={status:'healthy',token_stale:false};
    else if(path.endsWith('/data/scanner'))result=Array.from({length:10},(_,n)=>({code:String(9001+Math.floor(n/2)),name:'test'}));
    else if(path.includes('/data/contracts/'))result={security_type:'STK',code:path.split('/')[5],exchange:'TSE'};
    else if(path.endsWith('/data/kbars'))result={datetime:[String(body.start)+'T09:10:00'],Open:['30'],High:['31'],Low:['29'],Close:['30'],Volume:[1000]};
    else throw new Error('Unexpected endpoint');return new Response(JSON.stringify(result));
  };
  try {const request=BacktestRequestSchema.parse({start:'2026-07-01',end:'2026-07-03',source:'shioaji',strategy:'codex'});
    const load=()=>shioajiDataset(request,SettingsSchema.parse({}),dir,new AbortController().signal,()=>undefined,fetcher);
    const first=await load(),historyCount=calls.filter(x=>x.path.endsWith('/data/kbars')).length;assert.ok(first.points.length>0);
    assert.equal(calls.find(x=>x.path.endsWith('/data/scanner'))!.body.date,'2026-06-30');assert.equal(Object.keys(first.names).length,5);assert.equal(new Set(first.points.map(p=>p.symbol+':'+p.at)).size,first.points.length);
    await load();assert.equal(calls.filter(x=>x.path.endsWith('/data/kbars')).length,historyCount);
    const scannerCount=calls.filter(x=>x.path.endsWith('/data/scanner')).length;
    const selected=await shioajiDataset(BacktestRequestSchema.parse({...request,symbols:['9001']}),SettingsSchema.parse({}),dir,new AbortController().signal,()=>undefined,fetcher);
    assert.equal(calls.filter(x=>x.path.endsWith('/data/scanner')).length,scannerCount);assert.match(selected.source,/指定 1 檔股票/);
    assert.ok(calls.every(x=>!x.path.includes('/order/')&&!x.path.includes('/portfolio/')&&!x.path.includes('/auth/')));
    assert.ok(first.calendar!.some(s=>s.day==='2026-07-06'&&s.open));
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('replayed sell proceeds remain reserved until T+2 rather than funding new buys immediately',async()=>{
  const r=await runBacktest({...options(),strategy:'codex'},flatDataset(),SettingsSchema.parse({codex_enabled:true}),async s=>{
    const day=twDay(new Date(s.asof));return response(s,s.review_only?'HOLD':day===start&&!s.account.positions.length?'BUY':
      day==='2026-01-06'&&s.account.positions[0]?.sellable?'SELL':'HOLD');
  },new AbortController().signal,undefined,undefined,undefined,undefined,testSize);
  const saleDay=r.daily_equity.find(x=>x.day==='2026-01-06')!,settled=r.daily_equity.find(x=>x.day==='2026-01-08')!;
  assert.ok(d(saleDay.settlement_credits).gt(0));assert.equal(settled.settlement_credits,'0');
  assert.ok(d(settled.cash).gt(saleDay.cash));assert.ok(d(r.metrics.net_pnl).eq(d(r.metrics.realized_pnl).plus(r.metrics.unrealized_pnl)));
});
