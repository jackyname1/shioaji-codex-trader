import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ShioajiHttpBroker} from '../src/broker/http.js';
import {largestStockScanner} from '../src/broker/scanner.js';
import {historicalKbars} from '../src/broker/historical-format.js';
import {BrokerError} from '../src/broker/health.js';
import {Store} from '../src/core/store.js';
import {HistoricalMarket,syntheticDataset,validateDataset,csvDataset,type HistoryPoint} from '../src/core/backtest-data.js';
import {runBacktest} from '../src/core/backtest.js';
import {SettingsSchema,twDay,type Analysis} from '../src/core/models.js';
import {indicators,validateAnalysis} from '../src/core/strategy.js';
import {analysisPrompt} from '../src/core/codex.js';
import {rig,now,snapshot} from './helpers.js';

const top=Array.from({length:6},(_,i)=>({code:String(9001+i),name:'ISOLATED',close:30,total_amount:200000000+i*1000000}));
const thin=Array.from({length:6},(_,i)=>({code:String(9301+i),name:'ISOLATED',close:10,total_amount:4500+i*1000}));

test('realtime stock discovery reads the large end of Shioaji rankings, not the illiquid end',async()=>{
  const store=new Store(':memory:'),calls:{ascending:boolean;scanner_type:string}[]=[];
  const broker=new ShioajiHttpBroker(store,SettingsSchema.parse({}),false,async(input,init)=>{
    const path=new URL(String(input)).pathname;
    if(path.endsWith('/data/scanner')){const body=JSON.parse(String(init?.body));calls.push(body);return Response.json(body.ascending?top:thin);}
    if(path.includes('/data/contracts/'))return Response.json({security_type:'STK',code:path.split('/')[5],name:'ISOLATED',exchange:'TSE',
      category:'TEST',reference:30,limit_up:33,limit_down:27,trading_suspended:false,disposition_level:0,attention_flag:false,update_date:twDay(now)});
    throw new Error('No other endpoint is allowed');
  });
  try{const pool=await broker.discover(6,now);
    assert.equal(pool.length,6);assert.ok(pool.every(p=>Number(p.amount)>=200000000&&p.symbol.startsWith('900')));
    assert.equal(calls.length,3);assert.ok(calls.every(c=>c.ascending===true));
  }finally{await broker.close();store.close();}
});
test('the historical seed scanner uses its past date and sorts/deduplicates the actual trade amount',async()=>{
  let seen:unknown;
  const rows=await largestStockScanner({request:async(_path,body)=>{seen=body;return [top[1],top[0],top[1],{code:'0050',name:'ETF',close:100,total_amount:999999999}];}},'AmountRank','2026-09-11',200);
  assert.deepEqual(seen,{scanner_type:'AmountRank',date:'2026-09-11',ascending:true,count:200});
  assert.deepEqual(rows.map(r=>r.code),['9002','9001']);
});
test('official KBar Amount is TWD, while Volume is converted once from lots to shares',()=>{
  const rows=historicalKbars({datetime:['2026-09-11T09:01:00'],Open:[2225],High:[2235],Low:[2225],Close:[2230],Volume:[2565],Amount:[5708965000]},'9001');
  assert.equal(rows[0]!.volume_shares,2565000);assert.equal(rows[0]!.amount_twd,'5708965000');
  assert.throws(()=>historicalKbars({datetime:['2026-09-11T09:01:00'],High:[30],Low:[30],Close:[30],Volume:[1],Amount:[]},'9001'),/欄位長度/);
});
test('replay and indicators sum official daily amounts and exclude the current/future day',async()=>{
  const data=syntheticDataset('2026-01-05','2026-01-06');
  for(const p of data.points){p.open=p.high=p.low=p.close='30';p.amount_twd='1000000';}
  const market=new HistoricalMarket(data,'0.01'),asof=new Date('2026-01-05T09:15:00+08:00');
  const bars=await market.history('9001',asof),f=indicators(bars),prior=data.points.filter(p=>p.symbol==='9001'&&twDay(new Date(p.at))===bars.at(-1)!.date);
  assert.equal(f.daily_amount,String(prior.length*1000000));assert.equal(f.daily_amount_source,'TRADE_AMOUNT');
  assert.ok(bars.every(b=>b.date<'2026-01-05'));
  const pool=await market.discover(20,asof);assert.equal(pool.find(p=>p.symbol==='9001')!.amount,f.daily_amount);
});
test('CSV trade amounts are optional; mixed daily coverage is estimated rather than undercounted',async()=>{
  const rows=csvDataset('symbol,at,open,high,low,close,volume_shares,amount_twd\n9001,2026-01-02T09:01:00+08:00,30,30,30,30,1000,30000\n9001,2026-01-02T09:02:00+08:00,31,31,31,31,1000,\n');
  const bar=(await new HistoricalMarket(rows,'0.01').history('9001',new Date('2026-01-05T09:15:00+08:00')))[0]!;
  assert.equal(bar.volume,2000);assert.equal(bar.amount,undefined);
  const p:HistoryPoint={symbol:'9001',at:'2026-01-02T01:01:00Z',open:'30',high:'30',low:'30',close:'30',volume_shares:1000,amount_twd:'30000'};
  assert.throws(()=>validateDataset({...rows,points:[p,{...p,amount_twd:'31000'}]}),/不一致/);
});
test('the uploaded failure shape, empty HOLD_ONLY candidates, is valid and never authorizes a buy',()=>{
  const input=snapshot(),settings=SettingsSchema.parse({mode:'demo'});
  input.universe=Array.from({length:19},(_,i)=>({symbol:String(9301+i),name:'ISOLATED',last:'10',amount:String(4500+i*900),source:'ISOLATED'}));
  const result:Analysis={snapshot_id:input.snapshot_id,expires_at:new Date(now.getTime()+1800000).toISOString(),stance:'HOLD_ONLY',candidates:[],decisions:[],screening:null,summary:'沒有合格候選，保留現金'};
  assert.ok(validateAnalysis(result,input,now,settings).id);assert.match(analysisPrompt(input),/0 檔可回傳/);
  assert.throws(()=>validateAnalysis({...result,decisions:[{symbol:'9301',action:'BUY',shares:1,limit_price:'10',entry_when:'IMMEDIATE',trigger_price:'0',smart:{stop_price:'9',take_profit:null,trailing_activate:null,trailing_fraction:null},reason:'invalid'}]},input,now,settings));
});
test('empty but valid Codex strategies complete daily replay and reviews without an activation failure',async()=>{
  const data=syntheticDataset('2026-01-05','2026-01-06');for(const p of data.points)p.volume_shares=1;
  let snapshots=0;
  const report=await runBacktest({start:'2026-01-05',end:'2026-01-06',source:'sample',strategy:'codex',strategy_schedule:'fixed',strategy_times:['09:15'],max_codex_calls:10},data,
    SettingsSchema.parse({codex_enabled:true}),async input=>{
      snapshots++;assert.equal(input.data_readiness!.eligible_symbols.length,0);assert.equal(input.account.daily_loss_ratio,'0');
      assert.ok(input.account.daily_baseline_equity);assert.ok(input.instruments&&Object.keys(input.instruments).length);
      return {snapshot_id:input.snapshot_id,expires_at:new Date(Date.parse(input.asof)+1800000).toISOString(),stance:'HOLD_ONLY',candidates:[],decisions:[],screening:null,summary:'ISOLATED：無合格候選，維持觀望'};
    },new AbortController().signal);
  assert.equal(report.status,'COMPLETED');assert.equal((report.failures??[]).length,0);assert.equal(report.orders.length,0);
  assert.equal(report.quality.successful_strategies,2);assert.ok(snapshots>=2);assert.ok(report.strategy_log.every(s=>s.selected.length===0));
});
test('history failures remain visible by stock and retry can recover; live snapshots include actual risk and price-band data',async()=>{
  const r=await rig();try{
    const read=r.market.history.bind(r.market);r.store.set(`history_v2_${twDay(now)}_9001`,null);
    r.market.history=async(symbol,at)=>{if(symbol==='9001')throw new BrokerError('Shioaji 歷史 K 線暫時無法取得（HTTP 503）',true,503);return read(symbol,at);};
    const failed=await r.engine.collectBundle(now);assert.match(failed.features['9001']!.issue!,/歷史 K 線.*503/);
    const input=r.engine.snapshotFromBundle(failed,now);assert.ok(input.data_readiness!.history_issues.some(x=>x.symbol==='9001'&&x.issue.includes('503')));
    assert.equal(input.account.daily_baseline_equity,'100000');assert.equal(input.account.available_cash,'100000');assert.equal(input.account.buying_power,'75000');assert.equal(input.instruments!['9001']!.limit_up,'33');
    r.market.history=read;const recovered=await r.engine.collectBundle(now);assert.equal(recovered.features['9001']!.sufficient,true);assert.equal(recovered.features['9001']!.issue,undefined);
  }finally{await r.engine.close();r.store.close();}
});
