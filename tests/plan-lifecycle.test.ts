import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {planActive,planDeadline} from '../src/core/plan-lifecycle.js';
import {Store} from '../src/core/store.js';
import {runBacktest,type ReplayFrame} from '../src/core/backtest.js';
import {syntheticDataset} from '../src/core/backtest-data.js';
import {SettingsSchema,twDay,twClock,type Analysis,type Snapshot} from '../src/core/models.js';
import {strategyDirection} from '../src/desktop/dashboard.js';
import {now,rig} from './helpers.js';

test('activated strategy survives its reply deadline, persists on disk, and only a valid replacement changes it',async()=>{
  const root=mkdtempSync(join(tmpdir(),'strategy-lifecycle-')),path=join(root,'state.db');
  const r=await rig(new Store(path));let id='';try{
    const old=r.engine.plan!;id=old.id;
    assert.equal(old.lifecycle,'UNTIL_REPLACED');assert.equal(planDeadline(old),null);
    assert.equal(planActive(old,'2026-10-19T02:00:00Z'),true);
    assert.equal(planActive(old,'2026-10-07T02:00:00Z'),false);
    assert.equal(strategyDirection({plan:old} as never,{trade_direction:'auto'},'2026-10-19T02:00:00Z').restricted,false);
    assert.equal(planActive({...old,lifecycle:'TIMED'},'2026-10-19T02:00:00Z'),false);
    const input=await r.engine.snapshot(now),bad={...structuredClone(old.analysis),snapshot_id:'wrong'};
    await assert.rejects(r.engine.activate(bad,input,now));assert.equal(r.engine.plan!.id,id);
    const review={...input,review_only:true};
    await r.engine.activate({...bad,snapshot_id:review.snapshot_id,stance:'HOLD_ONLY',candidates:[],decisions:[],screening:null},review,now);
    assert.equal(r.engine.plan!.id,id);
    await r.engine.activate({...bad,snapshot_id:input.snapshot_id,stance:'HOLD_ONLY',candidates:[],decisions:[],screening:null},input,now);
    assert.notEqual(r.engine.plan!.id,id);id=r.engine.plan!.id;
  }finally{await r.engine.close();r.store.close();}
  const restored=new Store(path);try{
    assert.equal(restored.plan()!.id,id);assert.equal(restored.plan()!.lifecycle,'UNTIL_REPLACED');
    assert.ok(planActive(restored.plan(),'2026-10-19T02:00:00Z'));
  }finally{restored.close();rmSync(root,{recursive:true,force:true});}
});

test('a first-session strategy can buy on session four without extra analysis, then a valid session-six plan replaces it',async()=>{
  const data=syntheticDataset('2026-01-05','2026-01-12');
  data.points=data.points.filter(p=>p.symbol==='9001'&&['09:10','10:00','10:10','13:30'].includes(twClock(new Date(p.at))));
  for(const p of data.points){const price=twDay(new Date(p.at))==='2026-01-08'?'29':'30';p.open=p.high=p.low=p.close=price;p.volume_shares=1000000;}
  const frames:ReplayFrame[]=[],slots:{at:string;next:string|null}[]=[];
  const analyze=async(s:Snapshot):Promise<Analysis>=>{
    slots.push({at:s.asof,next:s.observation!.next_strategy_at});
    return {snapshot_id:s.snapshot_id,expires_at:new Date(Date.parse(s.asof)+60000).toISOString(),
      stance:slots.length===1?'BUY_ALLOWED':'HOLD_ONLY',candidates:slots.length===1?['9001']:[],screening:null,
      decisions:slots.length===1?[{symbol:'9001',action:'BUY',shares:30,limit_price:'30',entry_when:'BELOW',trigger_price:'29.5',
        smart:{stop_price:'27',take_profit:'40',trailing_activate:null,trailing_fraction:null},reason:'Synthetic lifecycle fixture'}]:[],summary:'Synthetic lifecycle fixture'};
  };
  const report=await runBacktest({start:'2026-01-05',end:'2026-01-12',source:'sample',strategy:'codex',strategy_every_sessions:5,
    strategy_schedule:'fixed',strategy_times:['09:15'],entry_cadence:'market',execution_sizing:'deterministic'},data,
    SettingsSchema.parse({codex_enabled:true,auto_watchlist:false}),analyze,new AbortController().signal,undefined,undefined,f=>frames.push(f));
  assert.equal(report.status,'COMPLETED');assert.equal(report.metrics.codex_calls,2);
  assert.equal(slots[0]!.next,new Date('2026-01-12T09:15:00+08:00').toISOString());assert.equal(slots[1]!.next,null);
  const buys=report.fills.filter(f=>f.action==='BUY');assert.ok(buys.length>0,JSON.stringify({orders:report.orders,failures:report.failures,states:frames.filter(f=>twDay(new Date(f.at))==='2026-01-08').at(-1)?.decisions}));
  assert.ok(buys.every(f=>twDay(new Date(f.at))==='2026-01-08'));
  assert.equal(report.orders.filter(o=>o.action==='BUY').length,1,'same-plan signal must not repeatedly buy');
  const day2=frames.find(f=>twDay(new Date(f.at))==='2026-01-06'&&f.plan)!.plan!;
  assert.equal(day2.lifecycle,'UNTIL_REPLACED');assert.ok(planActive(day2,'2026-01-09T02:00:00Z'));
  assert.notEqual(report.final_frame!.plan!.id,day2.id);assert.equal(report.final_frame!.plan!.analysis.stance,'HOLD_ONLY');
  assert.equal(report.diagnostics!.coverage.valid_plan_sessions,6);assert.equal(report.diagnostics!.coverage.buy_allowed_sessions,6); // Session six retains the old plan from 09:10 until its 09:15 replacement.
});
