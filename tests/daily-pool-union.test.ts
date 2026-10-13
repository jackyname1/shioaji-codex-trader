import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {partitionReplayHistory,validateDataset,HistoricalMarket,replayMinutesCsv,MAX_HISTORY_POINTS,type HistoryPoint,type HistoryDataset} from '../src/core/backtest-data.js';
import {shioajiDataset} from '../src/core/backtest-source.js';
import {BacktestRequestSchema,runBacktest,type BacktestReport} from '../src/core/backtest.js';
import {BacktestController} from '../src/core/backtest-controller.js';
import {SettingsSchema,addDays,twDay} from '../src/core/models.js';
import {csvRows} from '../src/core/facts.js';

const days=['2026-07-01','2026-07-02','2026-07-03'];
const ranks=Object.fromEntries(['2026-06-30','2026-07-01','2026-07-02'].map((date,index)=>[date,
  Array.from({length:40},(_,n)=>String(8001+index*40+n))]));
const request=BacktestRequestSchema.parse({start:days[0],end:days[2],source:'shioaji',strategy:'codex',strategy_schedule:'fixed',strategy_times:['09:15']});
const settings=SettingsSchema.parse({codex_enabled:true,candidate_pool_size:40,watch_min_amount:'0'});
const point=(symbol:string,day:string,clock:string,volume=100000,amount:string|undefined='3000000'):HistoryPoint=>({
  symbol,at:new Date(`${day}T${clock}:00+08:00`).toISOString(),open:'30',high:'31',low:'29',close:'30',volume_shares:volume,
  ...(amount!==undefined?{amount_twd:amount}:{})});
function history(symbol:string):HistoryPoint[]{
  const rows:HistoryPoint[]=[];
  for(let day=addDays(days[0]!,-150);day<=days[2]!;day=addDays(day,1)){
    if([0,6].includes(new Date(day+'T00:00:00Z').getUTCDay()))continue;
    for(const clock of ['09:10','09:11','13:30'])rows.push(point(symbol,day,clock));
  }
  return rows;
}
const fixture=(requests:string[]):typeof fetch=>async(input,init)=>{
  const path=new URL(String(input)).pathname,body=init?.body?JSON.parse(String(init.body)):{};requests.push(path);
  if(path.endsWith('/info')&&!path.includes('/contracts/'))return Response.json({simulation:false});
  if(path.endsWith('/health'))return Response.json({status:'healthy',token_stale:false});
  if(path.endsWith('/data/scanner'))return Response.json(ranks[body.date]!.map((code:string,n:number)=>({code,name:'ISOLATED STOCK',close:30,total_amount:100000000+n,date:body.date})));
  if(path.includes('/data/contracts/'))return Response.json({security_type:'STK',code:path.split('/')[5],name:'ISOLATED STOCK',exchange:'TSE'});
  throw new Error('Unexpected fixture endpoint '+path);
};

test('rotating daily ranks retain all 120 stocks, hide future members and keep exited holdings priced through the last session',async()=>{
  const root=mkdtempSync(join(tmpdir(),'daily-pool-union-')),calls:string[]=[],loaded:string[]=[];
  try{
    const dataset=await shioajiDataset(request,settings,root,new AbortController().signal,()=>undefined,fixture(calls),{
      history:async(_broker,_cache,symbol)=>{loaded.push(symbol);return history(symbol);},
    });
    assert.equal(new Set(loaded).size,120);assert.equal(Object.keys(dataset.names).length,120);
    for(const [index,day]of days.entries()){
      assert.deepEqual(new Set(dataset.daily_universe![day]!.symbols),new Set(Object.values(ranks)[index]));
      assert.equal(dataset.daily_universe![day]!.symbols.length,40);
    }
    assert.equal(dataset.minute_starts!['8001'],days[0]);assert.equal(dataset.minute_starts!['8081'],days[2]);
    assert.ok(dataset.points.filter(p=>p.symbol==='8081').every(p=>twDay(new Date(p.at))===days[2]));
    assert.equal(dataset.points.filter(p=>p.symbol==='8001').length,9,'A held first-day member keeps all later minutes after leaving the ranking');
    const market=new HistoricalMarket(dataset,'0.01');
    for(const [index,day]of days.entries())assert.deepEqual(new Set((await market.discover(40,new Date(day+'T09:15:00+08:00'))).map(r=>r.symbol)),new Set(Object.values(ranks)[index]));
    await market.subscribe(['8001'],false);
    assert.equal(market.quotes(new Date(days[2]+'T09:11:00+08:00'))[0]!.symbol,'8001');
    const original=new HistoricalMarket({source:'ISOLATED',synthetic:false,frequency:'MINUTE',points:history('8081'),names:{},limitations:[]},'0.01');
    assert.deepEqual(await market.history('8081',new Date(days[2]+'T09:15:00+08:00')),await original.history('8081',new Date(days[2]+'T09:15:00+08:00')));
    const report=await runBacktest(request,dataset,settings,async snapshot=>({snapshot_id:snapshot.snapshot_id,
      expires_at:new Date(Date.parse(snapshot.asof)+1800000).toISOString(),stance:'HOLD_ONLY',candidates:[],decisions:[],screening:null,summary:'ISOLATED HOLD'}),new AbortController().signal);
    assert.equal(report.status,'COMPLETED');assert.equal(report.quality.universe_sessions,3);assert.equal(report.orders.length,0);
    assert.ok(Object.values(report.quality.warmup).every(n=>n>=20));
    assert.ok(calls.every(path=>!path.includes('/order/')&&!path.includes('/portfolio/')&&!path.includes('/auth/')));
    const scans=calls.filter(path=>path.endsWith('/data/scanner')).length;
    const again=await shioajiDataset(request,settings,root,new AbortController().signal,()=>undefined,fixture(calls),{history:async(_b,_c,symbol)=>history(symbol)});
    assert.equal(calls.filter(path=>path.endsWith('/data/scanner')).length,scans,'All dated ranks remain reusable');
    assert.deepEqual(again.daily_universe,dataset.daily_universe);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('pre-entry compaction preserves chronological OHLC, volume and Decimal trade amounts, and never invents a missing amount',()=>{
  const a={...point('8001','2026-06-30','09:10',10,'0.1'),open:'30',high:'32',low:'29',close:'31'},
    b={...point('8001','2026-06-30','13:30',20,'0.2'),open:'31',high:'33',low:'30',close:'32'},
    current=point('8001','2026-07-01','09:10');
  const result=partitionReplayHistory([b,current,a],'2026-07-01');
  assert.deepEqual(result.points,[current]);assert.deepEqual(result.daily_history,[{symbol:'8001',at:b.at,open:'30',high:'33',low:'29',close:'32',volume_shares:30,amount_twd:'0.3'}]);
  assert.equal(partitionReplayHistory([a,{...b,amount_twd:undefined},current],'2026-07-01').daily_history[0]!.amount_twd,undefined);
  assert.ok(!('bid' in result.daily_history[0]!));
});

test('large union validation still rejects oversized daily membership, future warmup and duplicate daily aggregates',()=>{
  const rows=Array.from({length:120},(_,i)=>point(String(8001+i),days[0]!,'09:10'));
  const dataset:HistoryDataset={source:'ISOLATED',synthetic:false,frequency:'MINUTE',points:rows,names:{},limitations:[]};
  assert.equal(validateDataset(dataset).points.length,120);
  assert.throws(()=>validateDataset({...dataset,daily_universe:{[days[0]!]:{asof:'2026-06-30',symbols:rows.slice(0,101).map(p=>p.symbol)}}}));
  assert.throws(()=>validateDataset({...dataset,minute_starts:{'8001':days[0]!},daily_history:[point('8001',days[0]!,'08:00')]}),/未來資料/);
  assert.throws(()=>validateDataset({...dataset,daily_history:[point('8001','2026-06-30','09:10'),point('8001','2026-06-30','13:30')]}),/每日只能有一筆/);
  assert.throws(()=>validateDataset({...dataset,daily_history:new Array(MAX_HISTORY_POINTS)}),/300 萬筆/);
});

test('warmup daily rows never become minute replay events or CSV rows; complete JSON preserves membership and history',async()=>{
  const partition=partitionReplayHistory([point('8001','2026-06-30','09:10'),point('8001','2026-06-30','13:30'),point('8001',days[0]!,'09:10')],days[0]!);
  const dataset=validateDataset({source:'ISOLATED',synthetic:false,frequency:'MINUTE',...partition,minute_starts:{'8001':days[0]!},
    names:{},limitations:[],daily_universe:{[days[0]!]:{asof:'2026-06-30',symbols:['8001']}}});
  const market=new HistoricalMarket(dataset,'0.01');assert.equal(market.points.length,1);
  await market.subscribe(['8001'],false);
  assert.equal(market.quotes(new Date(partition.daily_history[0]!.at)).length,0,'A warmup aggregate cannot manufacture a minute quote or daily-volume liquidity');
  assert.equal(market.quotes(new Date(partition.points[0]!.at)).length,1);
  const csv=csvRows(replayMinutesCsv(dataset).replace(/^\uFEFF/,''));assert.equal(csv.length,1);assert.equal(csv[0]!.amount_twd,'3000000');
  const restored=validateDataset(JSON.parse(JSON.stringify(dataset)));assert.deepEqual(restored.daily_history,dataset.daily_history);assert.deepEqual(restored.daily_universe,dataset.daily_universe);
  const controller=new BacktestController('/unused');controller.marketData=async()=>restored;
  controller.report={asof:new Date(days[0]+'T14:00:00+08:00').toISOString()} as BacktestReport;
  const common={source:'replay',symbol:'8001',start:'2026-06-30',end:days[0]};
  const daily=await controller.chart({...common,interval:'1d'}),minutes=await controller.chart({...common,interval:'1m'});
  assert.equal(daily.bars.length,2);assert.equal(daily.bars[0]!.volume,200000);assert.equal(minutes.bars.length,1);assert.match(minutes.issue,/暖機日 K/);
});

test('cancellation after a history request stops before retaining its batch or loading the remaining pool',async()=>{
  const root=mkdtempSync(join(tmpdir(),'daily-pool-cancel-')),calls:string[]=[],abort=new AbortController();let loads=0;
  try{
    await assert.rejects(shioajiDataset(request,settings,root,abort.signal,()=>undefined,fixture(calls),{history:async(_b,_c,symbol)=>{
      loads++;abort.abort();return history(symbol);
    }}),e=>e instanceof Error&&e.name==='AbortError');
    assert.equal(loads,1);assert.equal(calls.filter(path=>path.includes('/data/contracts/')).length,1);
  }finally{rmSync(root,{recursive:true,force:true});}
});
