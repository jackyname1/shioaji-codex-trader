import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SettingsSchema,AnalysisSchema,twClock,type Screening,type Plan } from '../src/core/models.js';
import { Store } from '../src/core/store.js';
import { TradingCalendar } from '../src/core/calendar.js';
import { dueStrategy,nextStrategy,strategySlots,nextMonitorTime } from '../src/core/schedule.js';
import { emptyWatch,selectWatchlist,ruleEntry,type WatchBundle } from '../src/core/watchlist.js';
import { BacktestController } from '../src/core/backtest-controller.js';
import { runBacktest,replayEvents } from '../src/core/backtest.js';
import { syntheticDataset,type HistoryDataset } from '../src/core/backtest-data.js';
import { validateAnalysis } from '../src/core/strategy.js';
import { Risk } from '../src/core/risk.js';
import { account,instrument,order,quote,snapshot,settings,now,rig } from './helpers.js';

const policy=():Screening=>({min_amount:'20000000',min_volume_ratio:'0',rsi_min:0,rsi_max:100,return20_min:'-0.5',
  entry:{signal:'TREND',allocation_fraction:'0.02',max_ma20_distance:'0.10',stop_fraction:'0.05',take_profit_fraction:'0.10',trailing_fraction:'0.03'}});
const plan=():Plan=>({id:'plan',created_at:now.toISOString(),analysis:{snapshot_id:'snapshot',expires_at:new Date(now.getTime()+360*60000).toISOString(),
  stance:'BUY_ALLOWED',candidates:snapshot().universe.map(c=>c.symbol),decisions:[],screening:policy(),summary:'測試替身'}});
const bundle=():WatchBundle=>({pool:snapshot().universe.map(c=>({...c,amount:'50000000'})),
  features:Object.fromEntries(snapshot().universe.map(c=>[c.symbol,{sufficient:true,sessions:60,ma5:30,ma20:30,resistance20:31,
    rsi14:50,volume_ratio20:1,return20:0,daily_amount:'50000000'}])),metadata:Object.fromEntries(snapshot().universe.map(c=>[c.symbol,{...instrument(),symbol:c.symbol}]))});
function flat(start='2026-01-05',end='2026-01-09'):HistoryDataset{const data=syntheticDataset(start,end);for(const p of data.points)p.open=p.high=p.low=p.close='30';return data;}
test('fixed strategy times use Taipei sessions and persist one claim per slot, including restart and catch-up boundaries',()=>{
  const st=new Store(':memory:'),calendar=new TradingCalendar(st),s=SettingsSchema.parse({});try{
    assert.deepEqual(strategySlots('2026-10-08',s,calendar).map(x=>twClock(new Date(x.at))),['09:15','11:45','14:00']);
    assert.equal(strategySlots('2026-10-09',s,calendar).length,0);
    const clock=new Date('2026-10-08T09:20:00+08:00'),slot=dueStrategy(clock,s,calendar,()=>false)!;
    assert.equal(twClock(new Date(slot.at)),'09:15');st.set('schedule_'+slot.key,{started:true});
    assert.equal(dueStrategy(clock,s,calendar,key=>!!st.get('schedule_'+key)),undefined);
    assert.equal(dueStrategy(new Date('2026-10-08T10:00:00+08:00'),s,calendar,()=>false),undefined);
    assert.equal(twClock(new Date(nextStrategy(clock,s,calendar)!.at)),'11:45');
    assert.equal(nextStrategy(new Date('2026-10-08T15:00:00+08:00'),s,calendar)!.at.slice(0,10),'2026-10-12');
  }finally{st.close();}
});
test('interval schedules are independent of fast monitoring, have no pre-open odd-lot slot and apply the future opening change',()=>{
  const st=new Store(':memory:'),c=new TradingCalendar(st),s=SettingsSchema.parse({strategy_schedule:'interval',decision_interval_minutes:180});try{
    assert.deepEqual(strategySlots('2026-10-08',s,c).map(x=>twClock(new Date(x.at))),['09:10','12:10','14:00']);
    assert.equal(twClock(new Date(strategySlots('2026-12-08',s,c)[0]!.at)),'09:00');
    assert.equal(nextMonitorTime(new Date('2026-10-08T09:10:01+08:00'),3).toISOString(),'2026-10-08T01:10:03.000Z');
    assert.throws(()=>SettingsSchema.parse({strategy_times:['09:15','09:15']}));assert.throws(()=>SettingsSchema.parse({strategy_times:['13:30']}));
  }finally{st.close();}
});
test('watchlist adds qualified stocks and removes only after consecutive misses, while immediately revoking buy eligibility',()=>{
  const s=settings(),b=bundle(),p=plan();let w=selectWatchlist(emptyWatch(),b,s,p,account(),[],[],now);
  assert.equal(w.entries.length,5);assert.equal(w.adds,5);
  b.features['9001']!.rsi14=101;
  for(let i=1;i<=3;i++){w=selectWatchlist(w,b,s,p,account(),[],[],new Date(now.getTime()+i*1000));
    assert.equal(w.entries.some(e=>e.symbol==='9001'),i<3);if(i<3)assert.equal(w.entries.find(e=>e.symbol==='9001')!.eligible,false);}
  assert.equal(w.removes,1);assert.ok(w.changes.some(x=>x.action==='REMOVE'&&x.reason.includes('RSI')));
});
test('removing a held or pending symbol retains risk monitoring and never exceeds the observation cap',()=>{
  const s=SettingsSchema.parse({watch_max_symbols:5,watch_remove_after_scans:1}),b=bundle(),a=account();
  let w=selectWatchlist(emptyWatch(),b,s,plan(),a,[],[],now);a.positions=[{symbol:'9001',shares:10,sellable:0,average_price:'30',last_price:'30'}];
  b.pool=b.pool.filter(c=>!['9001','9002'].includes(c.symbol));
  w=selectWatchlist(w,b,s,plan(),a,[order({symbol:'9002',status:'PENDING'})],[],new Date(now.getTime()+1000));
  assert.equal(w.entries.find(x=>x.symbol==='9001')!.state,'RETAINED');assert.equal(w.entries.find(x=>x.symbol==='9002')!.state,'RETAINED');
  assert.equal(w.entries.find(x=>x.symbol==='9001')!.eligible,false);assert.ok(w.entries.filter(x=>x.state==='OBSERVE').length<=5);
});
test('watch filtering rejects stale metadata, suspended securities and insufficient completed history',()=>{
  const b=bundle();b.metadata['9001']!.verified_at='2026-10-07T09:00:00+08:00';b.metadata['9002']!.suspended=true;b.features['9003']!.sufficient=false;
  const w=selectWatchlist(emptyWatch(),b,settings(),plan(),account(),[],[],now);assert.deepEqual(w.entries.map(w=>w.symbol),['9004','9005']);
  assert.equal(w.healthy,true);assert.match(w.issue,/本輪 2 檔符合條件/);
});
test('new Codex priorities replace older unheld observations even when all still qualify, keeping the cap',()=>{
  const s=SettingsSchema.parse({watch_max_symbols:5}),b=bundle(),first=plan();let w=selectWatchlist(emptyWatch(),b,s,first,account(),[],[],now);
  for(let n=9006;n<=9010;n++){const symbol=String(n);b.pool.push({...b.pool[0]!,symbol});b.features[symbol]={...b.features['9001']!};b.metadata[symbol]={...instrument(),symbol};}
  const second=plan();second.id='next';second.analysis.candidates=['9006','9007','9008','9009','9010'];
  w=selectWatchlist(w,b,s,second,account(),[],[],new Date(now.getTime()+1000));
  assert.deepEqual(new Set(w.entries.map(w=>w.symbol)),new Set(second.analysis.candidates));assert.equal(w.entries.length,5);
  assert.ok(w.changes.some(c=>c.action==='REMOVE'&&c.reason.includes('新策略')));
});
test('rule sizing uses Decimal budget and stock ticks, odd-lot default and explicit common-lot enablement',()=>{
  const b=bundle(),w=selectWatchlist(emptyWatch(),b,settings(),plan(),account(),[],[],now).entries[0]!;
  const odd=ruleEntry(plan(),w,b.features[w.symbol],quote(),account(),settings(),now).decision!;
  assert.ok(odd.shares>0&&odd.shares<=999);assert.equal(odd.limit_price,'30.05');assert.ok(odd.smart);
  const a={...account(),cash:'1000000'},s=SettingsSchema.parse({whole_lots:true});const p=plan();p.analysis.screening!.entry!.allocation_fraction='0.10';
  assert.equal(ruleEntry(p,w,b.features[w.symbol],{...quote(),odd:false},a,s,now).decision!.shares%1000,0);
  assert.equal(ruleEntry(p,w,b.features[w.symbol],{...quote(),simulated:true},a,s,now).decision,undefined);
});
test('automatic size fits investable assets, reserved cash and hard symbol/exposure/day budgets before risk recheck',()=>{
  const st=new Store(':memory:');try{const s=settings(),b=bundle(),p=plan();p.analysis.screening!.entry!.allocation_fraction='0.10';
    const a=account(),w=selectWatchlist(emptyWatch(),b,s,p,a,[],[],now).entries[0]!,decision=ruleEntry(p,w,b.features[w.symbol],quote(),a,s,now).decision!;
    assert.ok(Number(decision.limit_price)*decision.shares<=7500);
    assert.deepEqual(new Risk(s,new TradingCalendar(st)).check(order({shares:decision.shares,limit_price:decision.limit_price}),a,quote(),instrument(),now,'100000'),[]);
    a.daily_buy_amount='20000';assert.equal(ruleEntry(p,w,b.features[w.symbol],quote(),a,s,now).decision,undefined);
  }finally{st.close();}
});
test('screening cannot exceed the local allocation or liquidity floors and review cannot authorize entries',()=>{
  const snap=snapshot(),p=plan();const s=SettingsSchema.parse({max_order_fraction:'0.01'});
  assert.throws(()=>validateAnalysis(p.analysis,snap,now,s));p.analysis.screening!.entry=null;p.analysis.screening!.min_amount='1';
  assert.throws(()=>validateAnalysis(p.analysis,snap,now,SettingsSchema.parse({})));
  p.analysis.screening=policy();assert.throws(()=>validateAnalysis(p.analysis,{...snap,review_only:true},now,settings()));
  assert.throws(()=>AnalysisSchema.parse({...p.analysis,screening:{...policy(),entry:{...policy().entry,stop_fraction:'0.001'}}}));
});
test('automatic rule entry protects a newly discovered stock, submits once per strategy and survives reload',async()=>{
  const r=await rig();try{const b=await r.engine.collectBundle(now);const snap=r.engine.snapshotFromBundle(b,now),p=plan();
    p.analysis.snapshot_id=snap.snapshot_id;p.analysis.candidates=snap.universe.map(c=>c.symbol);
    p.analysis.screening!.min_amount='20000000';for(const f of Object.values(snap.features)){f.daily_amount='50000000';f.ma5=f.ma20=30;f.resistance20=31;f.return20=0;}
    await r.engine.activate(p.analysis,snap,now);await r.engine.tick(now);await r.engine.tick(new Date(now.getTime()+3000));
    const buys=r.store.orders().filter(o=>o.symbol==='9001'&&o.action==='BUY');assert.equal(buys.length,1);assert.ok(buys[0]!.filled>0);
    assert.ok(r.store.protections().some(p=>p.symbol==='9001'));r.engine.entryBlocked=true;assert.equal(r.store.get('entry_blocked'),true);
    assert.equal(r.store.get<{entries:unknown[]}>('watch_state')!.entries.length,5);
  }finally{await r.engine.close();r.store.close();}
});
test('failed rule risk checks never create an unexecuted protection or consume an intent',async()=>{
  const r=await rig();try{r.store.removeProtection('9001');const o=order({local_id:'rule-refusal',shares:999000,lot:'ODD',plan_id:r.engine.plan!.id});
    assert.equal(await r.engine.submit(o,now,{stop_price:'29',take_profit:'35',trailing_activate:null,trailing_fraction:null}),false);
    assert.equal(r.store.protections().length,0);assert.equal(r.store.orders().length,0);
  }finally{await r.engine.close();r.store.close();}
});
test('enabled whole-lot rules work from fresh common quotes without requiring odd-lot trades',async()=>{
  const r=await rig();try{r.engine.setSettings({...r.engine.settings,whole_lots:true});
    r.market.quotes=at=>[{...quote(at),last:'7',bid:'6.99',ask:'7.01',odd:false,bid_shares:10000,ask_shares:10000}];
    r.market.instruments=async(symbols,at)=>Object.fromEntries(symbols.map(symbol=>[symbol,{...instrument(at),symbol,reference:'7',limit_down:'6.3',limit_up:'7.7'}]));
    const snap=await r.engine.snapshot(now);for(const f of Object.values(snap.features)){f.ma5=f.ma20=7;f.resistance20=7.05;f.daily_amount='50000000';}
    const a=plan().analysis;a.snapshot_id=snap.snapshot_id;a.screening!.entry!.allocation_fraction='0.10';
    await r.engine.activate(a,snap,now);await r.engine.tick(now);await r.engine.tick(new Date(now.getTime()+3000));
    assert.ok(r.store.orders().some(o=>o.lot==='COMMON'&&o.shares===1000&&o.filled===1000));assert.equal(r.engine.quotes.has('9001:true'),false);
  }finally{await r.engine.close();r.store.close();}
});
test('watch removal cancels an entry remainder but retains the held shares and independent next-session stop',async()=>{
  const r=await rig();try{await r.engine.tick(now);await r.engine.tick(new Date(now.getTime()+3000));
    assert.equal(r.store.orders()[0]!.filled,17);const b=await r.engine.collectBundle(now);b.pool=b.pool.filter(c=>c.symbol!=='9001');
    await r.engine.refreshWatch(b,new Date(now.getTime()+4000));
    assert.equal(r.store.orders()[0]!.status,'CANCELLED');assert.equal(r.engine.watch.entries.find(w=>w.symbol==='9001')!.state,'RETAINED');
    assert.ok(r.store.protections().some(p=>p.symbol==='9001'));
    const next=new Date('2026-10-12T10:00:00+08:00');r.market.marketPrice='28.5';
    await r.engine.tick(next);await r.engine.tick(new Date(next.getTime()+3000));
    assert.ok(r.store.orders().some(o=>o.purpose==='PROTECTION'&&o.filled===17));
  }finally{await r.engine.close();r.store.close();}
});
test('review preserves the active strategy and does not reset its independent protections',async()=>{
  const r=await rig();try{const old=r.engine.plan!.id,snap=await r.engine.snapshot(now,true);
    await r.engine.activate({...plan().analysis,snapshot_id:snap.snapshot_id,stance:'HOLD_ONLY',screening:null,decisions:[]},snap,now);
    assert.equal(r.engine.plan!.id,old);assert.ok(r.store.protections().length);assert.equal(r.store.reviews('demo',now.toISOString()).length,1);
  }finally{await r.engine.close();r.store.close();}
});
test('replay timer alignment retains genuine price events and distinct strategy, scan and condition ticks',()=>{
  const st=new Store(':memory:'),c=new TradingCalendar(st),s=SettingsSchema.parse({strategy_times:['09:15'],monitor_interval_seconds:7});try{
    const at='2026-01-05T01:10:00.000Z',events=replayEvents([at],['2026-01-05'],s,c);
    assert.equal(events.filter(e=>e.market).length,1);assert.ok(events.some(e=>e.at==='2026-01-05T01:15:00.000Z'&&e.decision===false));
    assert.ok(events.some(e=>e.check&&e.at===nextMonitorTime(new Date(at),7).toISOString()));
    assert.ok(events.some(e=>e.watch));assert.ok(events.some(e=>e.close));
  }finally{st.close();}
});
test('fixed-time replay analyzes only requested times plus review, uses auto observations and does not reuse the daily review as strategy',async()=>{
  const data=flat('2026-01-05','2026-01-06');
  const r=await runBacktest({start:'2026-01-05',end:'2026-01-06',strategy:'rules',strategy_schedule:'fixed',strategy_times:['09:15','11:45'],monitor_interval_seconds:7},data,SettingsSchema.parse({}),undefined,new AbortController().signal);
  assert.equal(r.status,'COMPLETED');assert.deepEqual(r.strategy_log.filter(x=>!x.review).map(x=>twClock(new Date(x.at))),['09:15','11:45','09:15','11:45']);
  assert.ok(r.metrics.watch_scans>r.quality.strategy_slots);assert.ok(r.metrics.monitor_checks>r.metrics.watch_scans);assert.ok(r.fills.length);
  assert.ok(r.fills.every(f=>Date.parse(f.at)>Date.parse(r.orders.find(o=>o.local_id===f.order_id)!.created_at)));
});
test('missing sessions report PARTIAL instead of claiming a completed period',async()=>{
  const data=flat();data.points=data.points.filter(p=>!p.at.startsWith('2026-01-07'));
  const r=await runBacktest({start:'2026-01-05',end:'2026-01-09',strategy:'rules'},data,SettingsSchema.parse({}),undefined,new AbortController().signal);
  assert.equal(r.status,'PARTIAL');assert.deepEqual(r.quality.missing_sessions,['2026-01-07']);
});
test('exhausted Codex coverage is PARTIAL after one valid strategy, and skips later entries within its total budget',async()=>{
  const r=await runBacktest({start:'2026-01-05',end:'2026-01-05',strategy:'codex',max_codex_calls:1},flat('2026-01-05','2026-01-05'),SettingsSchema.parse({codex_enabled:true}),async s=>({
    ...plan().analysis,snapshot_id:s.snapshot_id,expires_at:new Date(Date.parse(s.asof)+3600000).toISOString(),candidates:s.universe.slice(0,5).map(c=>c.symbol),screening:null,
  }),new AbortController().signal);
  assert.equal(r.status,'PARTIAL');assert.equal(r.metrics.codex_calls,1);assert.equal(r.quality.successful_strategies,1);assert.ok(r.quality.skipped_strategies>0);
});
test('raising a local liquidity floor revokes older strategy eligibility instead of letting its old threshold override settings',()=>{
  const b=bundle(),p=plan(),s=SettingsSchema.parse({watch_min_amount:'60000000'});
  const w=selectWatchlist(emptyWatch(),b,s,p,account(),[],[],now);assert.equal(w.entries.length,0);
});
test('simulation rejects insufficient warmup before calling a model or fabricating a performance report',async()=>{
  const data=flat('2026-01-05','2026-01-05');data.points=data.points.filter(p=>p.at.startsWith('2026-01-05'));let calls=0;
  await assert.rejects(()=>runBacktest({start:'2026-01-05',end:'2026-01-05',strategy:'codex'},data,SettingsSchema.parse({codex_enabled:true}),async()=>{calls++;return plan().analysis;},new AbortController().signal),/暖機不足/);
  assert.equal(calls,0);
});
test('automatic interval comparison saves independent accounts and restores selectable reports',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'comparison-'));try{const c=new BacktestController(dir);
    c.start({start:'2026-01-05',end:'2026-01-06',source:'sample',strategy:'demo',comparison_intervals:[60,180]},SettingsSchema.parse({}));await c.wait();
    assert.equal(c.comparisons.length,2);assert.notEqual(c.comparisons[0]!.id,c.comparisons[1]!.id);
    assert.equal(c.report!.metrics.initial_cash,'100000');const next=new BacktestController(dir);await next.restore();assert.equal(next.history.length,2);
    await next.select(c.comparisons[0]!.id);assert.equal(next.report!.request.decision_interval_minutes,60);
    await assert.rejects(()=>next.select('../latest.json'));
  }finally{rmSync(dir,{recursive:true,force:true});}
});

