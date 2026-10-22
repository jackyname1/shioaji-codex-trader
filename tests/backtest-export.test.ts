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
test('old reports identify trigger-band rejections and distinguish marked inventory from realized returns',async()=>{
  const r=await report();r.positions=[{symbol:'9001',shares:1,sellable:1,average_price:'30',last_price:'31'}];
  r.workflow=[{at:r.asof,stage:'RISK',message:'9001：停損不得位於或低於跌停價，不能視為可成交的保護'}];
  const codes=backtestDiagnostics(r).findings.map(f=>f.code);
  assert.ok(codes.includes('OPEN_POSITION_MARKS'));assert.ok(codes.includes('LEGACY_TRIGGER_BAND_REJECTION'));
  assert.match(backtestExport(r,'audit').content,/不能直接把遭拒訊號補算為獲利/);
});

test('order and failure CSV preserve rejected/unfilled orders and specific error and missing-data codes',async()=>{
  const r=await report();
  const orders=backtestExport(r,'orders');assert.equal(orders.extension,'csv');
  assert.match(orders.content,/local_id.*plan_id.*shares.*status/);
  // Synthetic reasons contain no newline, so each physical row corresponds to one complete order.
  assert.equal(orders.content.split('\r\n').length,r.orders.length+1);
  r.failures=[{at:'2026-09-09T01:15:00Z',review:false,stage:'ACTIVATION',issue:'策略驗證失敗',
    diagnostic:{kind:'OTHER',code:'REPLY_EXPIRED',validation_phase:'SEMANTIC'}}];
  r.quality.missing_sessions=['2026-09-10'];
  const failures=backtestExport(r,'failures').content;
  assert.match(failures,/REPLY_EXPIRED/);assert.match(failures,/MISSING_SESSION/);
  assert.equal(failures.split('\r\n').length,3);
  assert.match(backtestExport(r,'audit').content,/REPLY_EXPIRED/);
});

test('new CSV exports agree with raw unique funnel, strategy and execution attribution records',async()=>{
 const r=await report();
 for(const format of ['funnel','rejections','strategies','decisions','attribution'] as const){
  const output=backtestExport(r,format);assert.equal(output.extension,'csv');assert.ok(output.content.length>0);
 }
 assert.ok(r.entry_funnel);assert.match(backtestExport(r,'funnel').content,/signal_id.*stage.*not_required/);
 assert.match(backtestExport(r,'rejections').content,/signal_id.*code.*samples/);
 assert.match(backtestExport(r,'strategies').content,/lifecycle/);assert.match(backtestExport(r,'decisions').content,/run_id/);
 assert.match(backtestExport(r,'attribution').content,/reference_gross_pnl.*spread_cost.*modeled_price_impact/);
 assert.equal(r.diagnostics!.attribution!.closed.length,r.metrics.trades!.closed_trades);
 assert.equal(r.diagnostics!.attribution!.reconciled,true);assert.match(r.dataset_sha256!,/^[a-f0-9]{64}$/);
});
test('stale final marks expose symbol, cutoff, stage and error code in both UI diagnostics and error CSV',async()=>{
 const r=await report();r.positions=[{symbol:'9001',shares:1,sellable:1,average_price:'30',last_price:'31'}];
 r.quality.last_marks['9001']='2026-10-01T01:00:00Z';
 const diagnostics=backtestDiagnostics(r),issue=diagnostics.completeness.find(f=>f.code==='STALE_VALUATION');
 assert.ok(issue);assert.equal(issue.at,r.asof);assert.equal(issue.stage,'VALUATION');assert.match(issue.issue,/9001/);
 assert.match(backtestExport(r,'failures').content,/STALE_VALUATION/);assert.match(backtestExport(r,'audit').content,/不完整原因/);
});
