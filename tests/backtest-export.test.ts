import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runBacktest} from '../src/core/backtest.js';
import {syntheticDataset} from '../src/core/backtest-data.js';
import {backtestDiagnostics,backtestExport,csvCell} from '../src/core/backtest-export.js';
import {SettingsSchema} from '../src/core/models.js';

async function report(){return runBacktest({start:'2026-10-01',end:'2026-10-08',source:'sample',strategy:'demo'},syntheticDataset('2026-10-01','2026-10-08'),SettingsSchema.parse({}),undefined,new AbortController().signal);}
test('all export formats retain one run and reconcile fills, completed episodes and daily assets',async()=>{
  const r=await report(),json=JSON.parse(backtestExport(r,'json').content);
  assert.equal(json.id,r.id);assert.deepEqual(json.analyst_events,r.analyst_events);
  assert.deepEqual(json.diagnostics.trades,r.metrics.trades);assert.deepEqual(r.diagnostics,json.diagnostics);
  assert.equal(json.fills.length,r.metrics.fill_count);assert.equal(json.daily_equity.length,r.daily_equity.length);
  assert.equal(json.build.source_commit,r.build!.source_commit);assert.deepEqual(json.orders,r.orders);
  const fills=backtestExport(r,'csv').content;assert.match(fills,/order_id.*exit_trigger.*book_source/);
  assert.equal(fills.split('\r\n').length,r.fills.length+1);
  assert.equal(backtestExport(r,'trades').content.split('\r\n').length,r.metrics.trades!.closed_trades+1);
  assert.equal(backtestExport(r,'daily').content.split('\r\n').length,r.daily_equity.length+1);
  const audit=backtestExport(r,'audit');assert.equal(audit.extension,'md');assert.match(audit.content,/策略期限覆蓋交易日/);
  assert.match(audit.content,/合成示範資料/);assert.match(audit.content,/未平倉不計入勝率/);
  assert.throws(()=>backtestExport(r,'unknown' as never),/格式不合法/);
});
test('coverage follows replacement/expiry and the actual cutoff; buy permission is separate from valid HOLD',async()=>{
  const r=await report();r.strategy_log=[
    {at:'2026-10-01T01:15:00Z',expires_at:'2026-10-06T05:30:00Z',review:false,stance:'BUY_ALLOWED',summary:'fixture',selected:[]},
    {at:'2026-10-02T01:15:00Z',expires_at:'2026-10-02T03:00:00Z',review:false,stance:'HOLD_ONLY',summary:'replacement',selected:[]},
    {at:'2026-10-05T06:00:00Z',expires_at:'2026-10-06T05:30:00Z',review:true,stance:'BUY_ALLOWED',summary:'review only',selected:[]},
  ];
  const diag=backtestDiagnostics(r);assert.equal(diag.coverage.valid_plan_sessions,2);assert.equal(diag.coverage.buy_allowed_sessions,2);
  assert.ok(diag.coverage.no_valid_plan_days.includes('2026-10-05'));
  assert.ok(diag.findings.some(f=>f.code==='PLAN_COVERAGE_GAP'));
  r.asof='2026-10-01T03:00:00Z';assert.equal(backtestDiagnostics(r).coverage.observed_sessions,1);
});
test('negative expectancy, incomplete data and fee drag are described without claiming profitability',async()=>{
  const r=await report();r.status='PARTIAL';r.metrics.net_pnl='-100';r.metrics.gross_pnl='-50';
  assert.ok(backtestDiagnostics(r).findings.some(f=>f.code==='GROSS_LOSS'));
  assert.ok(backtestDiagnostics(r).findings.some(f=>f.code==='INCOMPLETE'));
  r.metrics.gross_pnl='50';assert.ok(backtestDiagnostics(r).findings.some(f=>f.code==='COST_DRAG'));
  assert.ok(!backtestDiagnostics(r).findings.some(f=>f.code==='GROSS_LOSS'));
});
test('CSV keeps numeric losses, escapes multiline quotes and neutralizes spreadsheet formulas',()=>{
  assert.equal(csvCell('-129.75'),'"-129.75"');assert.equal(csvCell('=HYPERLINK("test")'),'"\'=HYPERLINK(""test"")"');
  assert.equal(csvCell('two\n"lines"'),'"two\n""lines"""');assert.equal(csvCell('@cmd'),'"\'@cmd"');
});
