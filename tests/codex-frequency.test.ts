import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SettingsSchema,storedSettings,twClock} from '../src/core/models.js';
import {TradingService} from '../src/core/service.js';
import {Store} from '../src/core/store.js';
import {TradingCalendar} from '../src/core/calendar.js';
import {strategySlots} from '../src/core/schedule.js';
import {DesktopSettings} from '../src/desktop/settings.js';
import {BacktestRequestSchema,runBacktest} from '../src/core/backtest.js';
import {syntheticDataset} from '../src/core/backtest-data.js';
import {demoAnalysis} from '../src/core/strategy.js';

test('upgrade applies the low-usage policy once and preserves later user edits and risk limits',()=>{
  const old=SettingsSchema.parse({max_order_fraction:'0.06',codex_model:'chosen-model',strategy_times:['09:30']});
  const {codex_frequency_version:_,...legacy}=old;
  const upgraded=storedSettings(legacy);
  assert.deepEqual(upgraded.strategy_times,['09:15','11:45']);assert.equal(upgraded.codex_daily_call_limit,2);
  assert.equal(upgraded.postmarket_review_enabled,false);assert.equal(upgraded.execution_sizing,'deterministic');
  assert.equal(upgraded.max_order_fraction,'0.06');assert.equal(upgraded.codex_model,'chosen-model');
  assert.deepEqual(storedSettings({...upgraded,strategy_times:['10:00'],codex_daily_call_limit:3}).strategy_times,['10:00']);
});
test('live preferences and replay preferences persist independently across a desktop restart',()=>{
  const root=mkdtempSync(join(tmpdir(),'frequency-'));
  try{const prefs=new DesktopSettings(root),s=SettingsSchema.parse({strategy_times:['09:15','11:45'],replay_strategy_times:['10:10'],replay_max_codex_calls:7,replay_every_sessions:3});
    prefs.save(s);const restored=new DesktopSettings(root).apply(s,'paper',s.base_url);
    assert.deepEqual(restored.strategy_times,['09:15','11:45']);assert.deepEqual(restored.replay_strategy_times,['10:10']);
    assert.equal(restored.replay_max_codex_calls,7);assert.equal(restored.replay_every_sessions,3);assert.equal(restored.codex_daily_call_limit,2);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('two daily analysis attempts include failures, survive restarts, and reset by Taipei day',async()=>{
  const root=mkdtempSync(join(tmpdir(),'daily-budget-')),path=join(root,'paper.db');let at=new Date('2026-10-08T09:15:00+08:00');
  const create=()=>new TradingService(path,'paper',undefined,{now:()=>at,settings:SettingsSchema.parse({mode:'paper',codex_enabled:true})});
  let service=create(),attempts=0;
  const stub=(s:TradingService)=>{(s as unknown as {performDecision:()=>Promise<void>}).performDecision=async()=>{attempts++;throw new Error('isolated model failure');};};
  try{stub(service);await assert.rejects(service.decide(),/isolated/);await assert.rejects(service.decide(),/isolated/);
    await assert.rejects(service.decide(),/今日呼叫額度/);assert.equal(attempts,2);
    await service.close();service=create();stub(service);await assert.rejects(service.decide(),/今日呼叫額度/);
    at=new Date('2026-10-09T00:00:00+08:00');await assert.rejects(service.decide(),/isolated/);assert.equal(attempts,3);
  }finally{await service.close();rmSync(root,{recursive:true,force:true});}
});
test('default runtime has two slots without a paid review; enabling review is explicit',()=>{
  const store=new Store(':memory:'),calendar=new TradingCalendar(store,true),s=SettingsSchema.parse({});
  try{assert.deepEqual(strategySlots('2026-10-08',s,calendar).map(v=>twClock(new Date(v.at))),['09:15','11:45']);
    assert.equal(strategySlots('2026-10-08',{...s,postmarket_review_enabled:true},calendar).filter(v=>v.review).length,1);
  }finally{store.close();}
});
test('replay preset consumes one analysis per day with no review or quantity-model turns and respects its total cap',async()=>{
  const s=SettingsSchema.parse({codex_enabled:true}),day='2026-01-05',data=syntheticDataset(day,'2026-01-06');let calls=0;
  const request={start:day,end:'2026-01-06',source:'sample',strategy:'codex',strategy_schedule:s.replay_strategy_schedule,
    strategy_times:s.replay_strategy_times,max_codex_calls:1,execution_sizing:s.replay_execution_sizing};
  const report=await runBacktest(request,data,s,async snap=>{calls++;return demoAnalysis(snap,{...s,mode:'demo'},new Date(snap.asof));},new AbortController().signal);
  assert.equal(calls,1);assert.equal(report.metrics.codex_calls,1);assert.equal(report.settings.execution_sizing,'deterministic');
  assert.equal(report.reviews.length,0);assert.equal(report.status,'PARTIAL');assert.ok(report.quality.skipped_strategies>0);assert.equal(report.quality.halt_reason,'CODEX_BUDGET');
  assert.equal(BacktestRequestSchema.parse({start:day,end:day}).max_codex_calls,20);
});
