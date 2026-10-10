import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { historyWindows, buildChart, ChartRequestSchema } from '../src/core/chart.js';
import { BacktestRequestSchema, replayBounds, runBacktest } from '../src/core/backtest.js';
import { ReplayClock } from '../src/core/replay-clock.js';
import { BacktestController } from '../src/core/backtest-controller.js';
import { syntheticDataset } from '../src/core/backtest-data.js';
import { CredentialVault, brokerEnvironment, NativeConnection, ConnectionInputSchema } from '../src/desktop/credentials.js';
import { CodexAnalyst, type AnalystEvent, type Runner } from '../src/core/codex.js';
import { ShioajiHttpBroker } from '../src/broker/http.js';
import { Store } from '../src/core/store.js';
import { SettingsSchema, d } from '../src/core/models.js';
import { demoAnalysis } from '../src/core/strategy.js';
import { snapshot, settings, now } from './helpers.js';

test('history windows cover every requested date once, with at most 30 calendar dates per API call', () => {
  const windows = historyWindows('2026-01-01', '2026-03-04');
  assert.deepEqual(windows, [{ start: '2026-01-01', end: '2026-01-30' }, { start: '2026-01-31', end: '2026-03-01' }, { start: '2026-03-02', end: '2026-03-04' }]);
  assert.throws(() => historyWindows('2026-02-30', '2026-03-04'));
});
test('today is permitted and exact intraday replay bounds stop at the present time', () => {
  const r = BacktestRequestSchema.parse({ start: '2026-10-10', end: '2026-10-10', start_time: '09:30', end_time: '23:59' });
  const b = replayBounds(r, new Date('2026-10-10T11:42:00+08:00'));
  assert.equal(b.start, '2026-10-10T01:30:00.000Z'); assert.equal(b.end, '2026-10-10T03:42:00.000Z');
  assert.equal(SettingsSchema.parse({}).mode, 'paper'); assert.equal(r.source, 'shioaji');
});
test('chart candles, averages, bands, volume and RSI cannot use points after the simulated time', () => {
  const request = ChartRequestSchema.parse({ source: 'replay', symbol: '9001', start: '2026-01-01', end: '2026-02-28', interval: '1m' });
  const points = Array.from({ length: 80 }, (_, i) => ({ symbol: '9001', at: new Date(Date.parse('2026-01-05T09:01:00+08:00') + i * 60000).toISOString(),
    open: String(30 + i), high: String(31 + i), low: String(29 + i), close: String(30 + i), volume_shares: 1000 }));
  const cutoff = points[59]!.at, original = buildChart(points, request, cutoff);
  const changed = points.map((p, i) => i < 60 ? p : { ...p, high: '99999', close: '99999', volume_shares: 99999999 });
  assert.deepEqual(buildChart(changed, request, cutoff), original); assert.equal(original.bars.length, 60);
  assert.ok(original.bars.at(-1)!.ma60); assert.ok(original.bars.at(-1)!.upper); assert.equal(original.bars.at(-1)!.rsi, 100);
});
test('pause waits, one step releases one event, resume continues and cancellation unblocks the clock', async () => {
  const clock = new ReplayClock(), abort = new AbortController(); clock.command('pause'); let passed = false;
  const first = clock.before('2026-01-05T01:00:00Z', abort.signal).then(() => { passed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(passed, false);
  clock.command('step'); await first; assert.equal(passed, true); assert.equal(clock.paused, true);
  const pending = clock.before('2026-01-05T01:01:00Z', abort.signal); abort.abort(); await assert.rejects(pending);
  const active = new ReplayClock(); active.command('pause'); const resumed = active.before('2026-01-05T01:00:00Z', new AbortController().signal);
  active.command('resume'); await resumed; assert.throws(() => active.setSpeed(-1));
});
test('API secrets are encrypted at rest, are absent from CLI arguments and errors, and paper uses production data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vault-test-'));
  const input = ConnectionInputSchema.parse({ api_key: 'TEST_KEY', secret_key: 'TEST_SECRET', remember: true });
  const encryption = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(Buffer.from(s).map(n => n ^ 42)), decryptString: (b: Buffer) => Buffer.from(Buffer.from(b).map(n => n ^ 42)).toString() };
  try {
    const vault = new CredentialVault(root, encryption); await vault.save(input);
    assert.equal(readFileSync(join(root, 'connection.vault')).includes(Buffer.from('TEST_SECRET')), false);
    assert.deepEqual(await vault.read(), input); await vault.clear(); assert.equal(await vault.read(), undefined);
    await assert.rejects(new CredentialVault(root, { ...encryption, isEncryptionAvailable: () => false }).save(input), /系統加密/);
    const env = brokerEnvironment({ OPENAI_API_KEY: 'UNRELATED', LIVE_TRADING: 'true', PATH: '/bin' }, input);
    assert.equal(env.SJ_PRODUCTION, 'true'); assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.LIVE_TRADING, undefined);
    const commands: string[][] = []; let probes = 0;
    const native = new NativeConnection(root, async (_binary, args, opts) => { commands.push(args); if (args.includes('--help')) return { stdout: '--port --no-open' };
      assert.equal(opts.env.SJ_API_KEY, 'TEST_KEY'); return { stdout: '' }; }, async () => { if (++probes === 1) throw new Error('offline'); return Response.json({ simulation: false }); });
    await native.start(input, 'http://127.0.0.1:9081', false);
    assert.ok(commands.every(args => !args.join(' ').includes('TEST_'))); await native.close();
    const failure = new NativeConnection(root, async () => { throw new Error('TEST_SECRET'); }, async () => { throw new Error('offline'); });
    await assert.rejects(failure.start(input, 'http://127.0.0.1:9081', false), e => e instanceof Error && !e.message.includes('TEST_SECRET'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('paper rejects a simulated service before account reads, subscriptions or orders', async () => {
  const store = new Store(':memory:'), calls: string[] = [];
  const broker = new ShioajiHttpBroker(store, SettingsSchema.parse({ mode: 'paper' }), false, async input => { calls.push(String(input)); return Response.json({ simulation: true, version: '1.7.6' }); });
  try { await assert.rejects(broker.connect(), /真實行情/); assert.equal(calls.length, 1); } finally { await broker.close(); store.close(); }
});
test('Codex activity emits lifecycle and decisions without exposing private reasoning items', async () => {
  const input = snapshot(), analysis = demoAnalysis(input, settings(), now), events: AnalystEvent[] = [];
  const runner: Runner = async () => ({ events: (async function* () {
    yield { type: 'item.completed' as const, item: { id: 'r', type: 'reasoning' as const, text: 'PRIVATE_REASONING' } };
    yield { type: 'item.completed' as const, item: { id: 'm', type: 'agent_message' as const, text: JSON.stringify(analysis) } };
    yield { type: 'turn.completed' as const, usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } };
  })() });
  await new CodexAnalyst(SettingsSchema.parse({ codex_enabled: true }), '/unused', runner, undefined, e => events.push(e)).analyze(input);
  assert.deepEqual(events.map(e => e.stage), ['SNAPSHOT', 'RUNNING', 'VALIDATING', 'DECISION']);
  assert.ok(events.every(e => e.asof === input.asof)); assert.equal(JSON.stringify(events).includes('PRIVATE_REASONING'), false);
});
test('fast program replay requires no Codex calls, respects exact end time, and retains its full chart data after restore', async () => {
  const data = syntheticDataset('2026-01-05', '2026-01-06'), input = { start: '2026-01-05', end: '2026-01-06', source: 'sample', strategy: 'rules', end_time: '11:00' };
  const report = await runBacktest(input, data, SettingsSchema.parse({}), undefined, new AbortController().signal);
  assert.equal(report.metrics.codex_calls, 0); assert.ok(Date.parse(report.asof) <= Date.parse('2026-01-06T11:00:59.999+08:00'));
  assert.ok(report.timeline?.length); assert.ok(d(report.metrics.final_equity).isFinite());
  const root = mkdtempSync(join(tmpdir(), 'chart-report-'));
  try { const controller = new BacktestController(root); controller.start(input, SettingsSchema.parse({})); await controller.wait();
    const next = new BacktestController(root); await next.restore();
    const chart = await next.chart({ source: 'replay', symbol: '9001', start: input.start, end: input.end, interval: '1m' });
    assert.ok(chart.bars.length); assert.ok(chart.bars.every(b => b.at <= next.report!.asof));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
