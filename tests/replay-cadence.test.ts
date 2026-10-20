import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/core/store.js';
import {TradingCalendar} from '../src/core/calendar.js';
import {SettingsSchema,storedSettings,twDay,twClock,type Snapshot,type Analysis} from '../src/core/models.js';
import {BacktestRequestSchema,replayEvents,replayAnalysisDays,runBacktest} from '../src/core/backtest.js';
import {syntheticDataset} from '../src/core/backtest-data.js';

test('desktop replay defaults to five sessions, preserves explicit daily preferences and legacy request compatibility',()=>{
  const defaults=SettingsSchema.parse({});assert.equal(defaults.replay_every_sessions,5);
  const {replay_every_sessions:_,...old}=defaults;
  assert.equal(storedSettings(old).replay_every_sessions,5);
  assert.equal(storedSettings({...defaults,replay_every_sessions:1}).replay_every_sessions,1);
  assert.equal(BacktestRequestSchema.parse({start:'2026-01-05',end:'2026-01-06'}).strategy_every_sessions,1);
  for(const value of [0,21,1.5])assert.equal(BacktestRequestSchema.safeParse({start:'2026-01-05',end:'2026-01-06',strategy_every_sessions:value}).success,false);
});
test('five-session spacing counts known missing sessions, skips closures and retains off-day market, watch and protection checks',()=>{
  const store=new Store(':memory:'),calendar=new TradingCalendar(store,true);
  try{
    store.saveSessions([{day:'2026-01-13',open:true,source:'isolated calendar',verified_at:'2026-01-01T00:00:00Z'},
      {day:'2026-01-14',open:false,source:'isolated calendar',verified_at:'2026-01-01T00:00:00Z'}]);
    const days=['2026-01-09','2026-01-12','2026-01-14','2026-01-15','2026-01-16','2026-01-19'];
    const at='2026-01-12T01:17:00.000Z';
    const events=replayEvents([at],days,SettingsSchema.parse({monitor_interval_seconds:300,postmarket_review_enabled:true,strategy_times:['09:15']}),calendar,5,'2026-01-09');
    assert.deepEqual(events.filter(e=>e.decision===false).map(e=>twDay(new Date(e.at))),['2026-01-09','2026-01-19']);
    assert.deepEqual(events.filter(e=>e.decision===true).map(e=>twDay(new Date(e.at))),['2026-01-09','2026-01-19']);
    assert.ok(events.some(e=>e.at===at&&e.market));
    for(const day of ['2026-01-12','2026-01-15','2026-01-16']){
      assert.ok(events.some(e=>twDay(new Date(e.at))===day&&e.check));
      assert.ok(events.some(e=>twDay(new Date(e.at))===day&&e.watch));
      assert.ok(events.some(e=>twDay(new Date(e.at))===day&&e.close));
    }
    assert.equal(events.some(e=>twDay(new Date(e.at))==='2026-01-14'),false);
    assert.throws(()=>replayAnalysisDays(days,calendar,0),/1–20/);
  }finally{store.close();}
});
function fixture(){
  const data=syntheticDataset('2026-01-05','2026-01-12'),symbol=data.points[0]!.symbol;
  data.points=data.points.filter(p=>p.symbol===symbol&&['09:15','13:30'].includes(twClock(new Date(p.at))));
  return data;
}
const hold=(s:Snapshot):Analysis=>({snapshot_id:s.snapshot_id,expires_at:new Date(Date.parse(s.asof)+3600000).toISOString(),
  stance:'HOLD_ONLY',candidates:[],decisions:[],screening:null,summary:'Isolated cadence test; no order proposal'});
test('a six-session replay analyses on sessions one and six only, including reviews, while all days still reach their close',async()=>{
  const calls:string[]=[];
  const r=await runBacktest({start:'2026-01-05',end:'2026-01-12',source:'sample',strategy:'codex',strategy_every_sessions:5,
    strategy_schedule:'fixed',strategy_times:['09:15'],postmarket_review_enabled:true},fixture(),
    SettingsSchema.parse({codex_enabled:true,auto_watchlist:false}),async s=>{calls.push(s.asof);return hold(s);},new AbortController().signal);
  assert.equal(r.status,'COMPLETED');assert.equal(r.metrics.codex_calls,4);assert.equal(calls.length,4);
  assert.deepEqual(r.strategy_log.filter(x=>!x.review).map(x=>twDay(new Date(x.at))),['2026-01-05','2026-01-12']);
  assert.equal(r.reviews.length,2);assert.equal(r.daily_equity.length,6);assert.ok(r.daily_equity.every(d=>d.complete));
  assert.ok(r.metrics.monitor_checks>6);assert.equal(r.quality.skipped_strategies,0);
  assert.ok(r.strategy_log.every(x=>Date.parse(x.expires_at)===Date.parse(x.at)+3600000));
  assert.equal(r.settings.replay_every_sessions,5);
});
test('the call budget stops at the next required analysis instead of replaying the remainder without fresh strategies',async()=>{
  const r=await runBacktest({start:'2026-01-05',end:'2026-01-12',source:'sample',strategy:'codex',strategy_every_sessions:1,
    strategy_schedule:'fixed',strategy_times:['09:15'],max_codex_calls:1},fixture(),
    SettingsSchema.parse({codex_enabled:true,auto_watchlist:false}),async s=>hold(s),new AbortController().signal);
  assert.equal(r.status,'PARTIAL');assert.equal(r.metrics.codex_calls,1);
  assert.equal(r.quality.halt_reason,'CODEX_BUDGET');assert.equal(r.asof,new Date('2026-01-06T09:15:00+08:00').toISOString());
  assert.equal(r.daily_equity.at(-1)!.complete,false);
  assert.ok(r.workflow!.every(x=>Date.parse(x.at)<=Date.parse(r.asof)));
  assert.ok(r.limitations.some(x=>x.includes('不繼續模擬剩餘期間')));
});
test('an afternoon start anchors at the next available analysis slot and does not wait an extra five sessions',async()=>{
  const r=await runBacktest({start:'2026-01-05',start_time:'12:00',end:'2026-01-12',source:'sample',strategy:'codex',
    strategy_every_sessions:5,strategy_schedule:'fixed',strategy_times:['09:15']},fixture(),
    SettingsSchema.parse({codex_enabled:true,auto_watchlist:false}),async s=>hold(s),new AbortController().signal);
  assert.equal(r.status,'COMPLETED');assert.equal(r.metrics.codex_calls,1);
  assert.equal(twDay(new Date(r.strategy_log[0]!.at)),'2026-01-06');
});
