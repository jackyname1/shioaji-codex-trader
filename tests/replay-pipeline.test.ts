import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChartViewport} from '../src/desktop/chart-viewport.js';
import {cachedHistory} from '../src/core/history-cache.js';
import {normalizeHistoryPoints,syntheticDataset,type HistoryDataset} from '../src/core/backtest-data.js';
import {runBacktest,type ReplayFrame,type ReplayActivity,type BacktestProgress} from '../src/core/backtest.js';
import {ReplayClock} from '../src/core/replay-clock.js';
import {CodexError} from '../src/core/codex.js';
import {SettingsSchema,twDay,type Snapshot,type Analysis} from '../src/core/models.js';
import {ShioajiHttpBroker} from '../src/broker/http.js';
import {Store} from '../src/core/store.js';

const start='2026-01-05',end='2026-01-06';
const nextTurn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function flat():HistoryDataset {const data=syntheticDataset(start,end);for(const p of data.points){p.open=p.high=p.low=p.close='30';p.volume_shares=1000000;}return data;}
function rules(s:Snapshot):Analysis {return {snapshot_id:s.snapshot_id,expires_at:new Date(Date.parse(s.asof)+90*60000).toISOString(),
  stance:s.review_only?'HOLD_ONLY':'BUY_ALLOWED',candidates:s.universe.slice(0,5).map(c=>c.symbol),decisions:[],
  screening:s.review_only?null:{min_amount:'20000000',min_volume_ratio:'0',rsi_min:0,rsi_max:100,return20_min:'-0.5',
    entry:{signal:'TREND',allocation_fraction:'0.02',max_ma20_distance:'0.10',stop_fraction:'0.05',take_profit_fraction:'0.10',trailing_fraction:'0.03'}},
  summary:s.review_only?'測試替身：完成盤後成本與執行檢討':'測試替身：每日選股並授權受限規則進場'};}

test('history normalizes equivalent timestamps/prices once and preserves distinct stocks and minutes',()=>{
  const p=flat().points[0]!,copy={...p,at:new Date(p.at).toISOString(),close:Number(p.close).toFixed(2)};
  const normalized=normalizeHistoryPoints([p,copy,{...p,symbol:'9999'},{...p,at:new Date(Date.parse(p.at)+60000).toISOString()}]);
  assert.equal(normalized.points.length,3);assert.equal(normalized.duplicates,1);assert.equal(normalized.revisions,0);
  assert.throws(()=>normalizeHistoryPoints([p,{...p,volume_shares:p.volume_shares+1}]),/價格或成交量不一致/);
});
test('provider duplicate/revised bars are cached once without inflating volume and remain bounded by replay cutoff',async()=>{
  const root=mkdtempSync(join(tmpdir(),'duplicate-history-')),store=new Store(':memory:');let calls=0;const counts:{duplicates:number;revisions:number}[]=[];
  const broker=new ShioajiHttpBroker(store,SettingsSchema.parse({}),false,async()=>{calls++;return Response.json({
    datetime:['2026-01-05T09:10:00','2026-01-05T09:10:00','2026-01-05T09:10:00','2026-01-05T09:11:00'],
    Open:[30,30,30,31],High:[31,31,32,32],Low:[29,29,29,30],Close:[30,30,31,31],Volume:[100,100,120,150]});});
  const load=(cutoff:string)=>cachedHistory(broker,root,'9001','TSE',start,start,`${start}T${cutoff}+08:00`,new AbortController().signal,()=>undefined,c=>counts.push(c));
  try{const first=await load('09:10:00');assert.equal(first.length,1);assert.equal(first[0]!.close,'31');assert.equal(first[0]!.volume_shares,120000);
    const second=await load('09:11:00');assert.equal(second.length,2);assert.equal(second[1]!.volume_shares,150000);assert.equal(calls,1);
    assert.equal(counts.reduce((n,c)=>n+c.duplicates,0),2);assert.equal(counts.reduce((n,c)=>n+c.revisions,0),1);
  }finally{await broker.close();store.close();rmSync(root,{recursive:true,force:true});}
});
test('chart zoom anchors the mouse, drag and slider share a viewport, updates preserve inspection and latest follows new bars',()=>{
  const viewport=new ChartViewport(),times=Array.from({length:500},(_,i)=>new Date(i*60000).toISOString());viewport.sync(times,'9001:1m');
  assert.equal(viewport.offset,380);viewport.move(100);const anchor=viewport.offset+viewport.visible*.25;
  viewport.zoom(.5,.25);assert.equal(viewport.count,60);assert.equal(viewport.offset+viewport.visible*.25,anchor);
  viewport.pan(-20);const left=times[viewport.offset];viewport.sync([...times,new Date(500*60000).toISOString()],'9001:1m');assert.equal(times[viewport.offset],left);assert.equal(viewport.following,false);
  viewport.sync([new Date(-60000).toISOString(),...times],'9001:1m');assert.equal(viewport.offset,96);
  viewport.latest();assert.equal(viewport.offset,441);viewport.sync([...times,new Date(500*60000).toISOString(),new Date(501*60000).toISOString()],'9001:1m');assert.equal(viewport.offset,442);
  viewport.scalePrice(2);assert.equal(viewport.priceScale,2);viewport.reset();assert.equal(viewport.count,120);assert.equal(viewport.priceScale,1);
  viewport.sync(times.slice(0,10),'9002:1m');viewport.zoom(.1);assert.equal(viewport.visible,10);assert.equal(viewport.maximum,0);
  viewport.move(-999);assert.equal(viewport.offset,0);viewport.fit();assert.equal(viewport.offset,0);
});
test('paused slow Codex selection freezes virtual time; single step completes activation, risk, submission and reconciliation',async()=>{
  const clock=new ReplayClock(),abort=new AbortController(),frames:ReplayFrame[]=[],activities:ReplayActivity[]=[],progress:BacktestProgress[]=[];
  let release!:()=>void,entered!:()=>void,calls=0;const gate=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{entered=resolve;});
  const running=runBacktest({start,end,source:'sample',strategy:'codex',strategy_schedule:'interval',decision_interval_minutes:360},flat(),SettingsSchema.parse({codex_enabled:true}),async s=>{
    if(++calls===1){entered();await gate;}return rules(s);
  },abort.signal,p=>progress.push(structuredClone(p)),clock,f=>frames.push(f),e=>activities.push(e));
  await began;const frozen=frames.at(-1)!.at;clock.setSpeed(100000);clock.command('pause');await nextTurn();
  assert.equal(calls,1);assert.equal(frames.at(-1)!.at,frozen);assert.equal(progress.at(-1)!.phase,'ANALYSIS');assert.equal(progress.at(-1)!.at,frozen);
  release();for(let n=0;n<30&&!frames.at(-1)?.account.orders.length;n++)await nextTurn();
  assert.equal(frames.at(-1)!.at,frozen);assert.ok(frames.at(-1)!.plan?.analysis.screening?.entry);assert.ok(frames.at(-1)!.account.orders.length);
  assert.ok(frames.at(-1)!.decisions?.some(d=>d.state==='PENDING'));assert.ok(activities.some(e=>e.stage==='SUBMISSION'));assert.ok(activities.every(e=>e.at===frozen));
  const count=frames.length;await nextTurn();assert.equal(frames.length,count,'No next event runs while paused');
  clock.command('step');for(let n=0;n<30&&frames.at(-1)!.at===frozen;n++)await nextTurn();
  assert.ok(Date.parse(frames.at(-1)!.at)>Date.parse(frozen));assert.equal(clock.paused,true);assert.equal(calls,1);
  clock.setSpeed(0);clock.command('resume');const report=await running;
  assert.equal(report.status,'COMPLETED');assert.equal(report.quality.successful_strategies,2);assert.equal(report.metrics.codex_calls,4);
  assert.deepEqual(report.strategy_log.filter(s=>!s.review).map(s=>twDay(new Date(s.at))),[start,end]);
  for(const day of [start,end])assert.ok(report.workflow!.some(e=>twDay(new Date(e.at))===day&&e.stage==='ACTIVATION'&&e.screening?.entry));
  assert.ok(report.fills.length>0);for(const fill of report.fills){const order=report.orders.find(o=>o.local_id===fill.order_id)!;assert.ok(Date.parse(fill.at)>Date.parse(order.created_at));}
  assert.ok(report.workflow!.some(e=>e.stage==='FILL'));assert.ok(report.workflow!.some(e=>e.stage==='CLOSE'));assert.ok(report.reviews.length===2);
});
test('fast-forward changes waiting only: prices, selections, automatic order/fill times and costs match a stepped run',async()=>{
  const options={start,end:start,source:'sample',strategy:'codex',end_time:'09:31',strategy_schedule:'interval',decision_interval_minutes:360};
  const run=async(stepped:boolean)=>{const clock=new ReplayClock();clock.setSpeed(stepped?100000:0);
    return runBacktest(options,flat(),SettingsSchema.parse({codex_enabled:true}),async s=>{await nextTurn();return rules(s);},new AbortController().signal,()=>undefined,clock);};
  const fast=await run(false),paced=await run(true);
  assert.deepEqual(paced.strategy_log,fast.strategy_log);assert.deepEqual(paced.metrics,fast.metrics);assert.deepEqual(paced.daily_equity,fast.daily_equity);
  const fills=(r:typeof fast)=>r.fills.map(({id,order_id,...f})=>f);assert.deepEqual(fills(paced),fills(fast));
  const orders=(r:typeof fast)=>r.orders.map(({local_id,broker_id,tag,plan_id,...o})=>o);assert.deepEqual(orders(paced),orders(fast));
});
test('a plan expiration remains a trigger between bars and cancels its remainder before any later fill',async()=>{
  const report=await runBacktest({start,end:start,source:'sample',strategy:'codex',end_time:'09:31',strategy_schedule:'interval',decision_interval_minutes:360},flat(),SettingsSchema.parse({codex_enabled:true}),async s=>{
    const a=rules(s);a.expires_at=new Date(Date.parse(s.asof)+60000).toISOString();a.screening!.entry=null;
    a.decisions=[{symbol:a.candidates[0]!,action:'BUY',shares:10,limit_price:'29.5',entry_when:'IMMEDIATE',trigger_price:'0',reason:'測試未成交掛單',smart:{stop_price:'29',take_profit:'33',trailing_activate:null,trailing_fraction:null}}];return a;
  },new AbortController().signal);
  const order=report.orders[0]!;assert.equal(order.status,'CANCELLED');assert.equal(order.filled,0);
  const cancelled=report.workflow!.find(e=>e.stage==='RECONCILE'&&e.message.includes('CANCELLED'))!;assert.equal(cancelled.at,new Date(start+'T09:11:00+08:00').toISOString());
  assert.equal(report.final_frame!.decisions!.find(d=>d.symbol===order.symbol)!.state,'CANCELLED');
});
test('Codex failure preserves its specific reason and later sessions recover without reusing a failed plan',async()=>{
  let failed=false;const report=await runBacktest({start,end,source:'sample',strategy:'codex',strategy_schedule:'interval',decision_interval_minutes:360},flat(),SettingsSchema.parse({codex_enabled:true}),async s=>{
    if(!failed){failed=true;throw new CodexError('Codex 測試額度暫時不足');}return rules(s);
  },new AbortController().signal);
  assert.equal(report.status,'PARTIAL');assert.equal(report.failures!.length,1);assert.equal(report.failures![0]!.issue,'Codex 測試額度暫時不足');
  assert.equal(report.failures![0]!.stage,'ANALYSIS');assert.ok(report.workflow!.some(e=>e.stage==='FAILED'&&e.message.includes('額度暫時不足')));
  assert.ok(report.strategy_log.some(s=>!s.review&&twDay(new Date(s.at))===end));assert.ok(report.fills.every(f=>twDay(new Date(f.at))===end));
});
