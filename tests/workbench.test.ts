import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { brokerOrigin, bundledShioajiPath } from '../src/desktop/broker-runtime.js';
import { workspaceRuntime, workspaceEvents, workspaceCutoff } from '../src/desktop/workspace.js';
import type { DesktopState, RuntimeView } from '../src/desktop/shared.js';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { historyWindows, buildChart, ChartRequestSchema } from '../src/core/chart.js';
import { BacktestRequestSchema, replayBounds, runBacktest } from '../src/core/backtest.js';
import { ReplayClock } from '../src/core/replay-clock.js';
import { BacktestController } from '../src/core/backtest-controller.js';
import { cachedHistory } from '../src/core/history-cache.js';
import { syntheticDataset } from '../src/core/backtest-data.js';
import { CredentialVault, brokerEnvironment, NativeConnection, ConnectionInputSchema } from '../src/desktop/credentials.js';
import { CodexAnalyst, type AnalystEvent, type Runner } from '../src/core/codex.js';
import { ShioajiHttpBroker } from '../src/broker/http.js';
import { Store } from '../src/core/store.js';
import { SettingsSchema, d } from '../src/core/models.js';
import { demoAnalysis } from '../src/core/strategy.js';
import { snapshot, settings, now, instrument } from './helpers.js';

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
    const commands: string[][] = []; let probes = 0;const binary=async()=>join(root,'shioaji');const origin=async()=>'http://127.0.0.1:9081';
    const native = new NativeConnection(root,binary,{origin,run: async (_binary, args, opts) => { commands.push(args); if (args.includes('--help')) return { stdout: '--no-open' };
      assert.equal(opts.env.SJ_API_KEY, 'TEST_KEY'); return { stdout: '' }; },fetcher: async () => { if (++probes === 1) throw new Error('offline'); return Response.json({ simulation: false }); },launch:((_binary:string,args:string[],opts:Record<string,unknown>)=>{commands.push(args);assert.equal((opts.env as NodeJS.ProcessEnv).SJ_HTTP_ADDR,'127.0.0.1:9081');assert.equal((opts.env as NodeJS.ProcessEnv).SJ_HOME_PATH,root);
      assert.deepEqual(args,['server','start','--no-open']);assert.equal((opts.env as NodeJS.ProcessEnv).SJ_API_KEY,'TEST_KEY');
      const child=new EventEmitter() as EventEmitter&{exitCode:number|null;kill:()=>boolean};child.exitCode=null;child.kill=()=>{child.exitCode=0;setImmediate(()=>child.emit('exit'));return true;};return child;}) as typeof spawn});
    await native.start(input,false);assert.equal(native.connected,true);assert.equal(native.baseUrl,'http://127.0.0.1:9081');
    assert.ok(commands.every(args => !args.join(' ').includes('TEST_'))); await native.close();
    const failure = new NativeConnection(root,binary,{origin,run:async()=>{throw new Error('TEST_SECRET');},fetcher:async()=>{throw new Error('offline');}});
    await assert.rejects(failure.start(input,false), e => e instanceof Error && !e.message.includes('TEST_SECRET'));
    let failedProbes=0,killed=false;
    const rejected = new NativeConnection(root,binary,{origin,run:async()=>({stdout:'--no-open'}),fetcher:async()=>{if(++failedProbes===1)throw new Error('offline');return Response.json({simulation:true});},launch:(()=>{
      const child=new EventEmitter() as EventEmitter&{exitCode:number|null;kill:()=>boolean};child.exitCode=null;child.kill=()=>{killed=true;child.exitCode=0;setImmediate(()=>child.emit('exit'));return true;};return child;
    }) as unknown as typeof spawn});
    await assert.rejects(rejected.start(input,false),/連線未完成/);assert.equal(killed,true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('a historical cache retains the complete API window when an earlier replay ends intraday', async()=>{
  const root=mkdtempSync(join(tmpdir(),'cutoff-cache-')),store=new Store(':memory:');let calls=0;
  const broker=new ShioajiHttpBroker(store,SettingsSchema.parse({}),false,async()=>{calls++;return Response.json({datetime:['2026-01-05T09:10:00','2026-01-05T09:11:00'],Open:[30,31],High:[31,32],Low:[29,30],Close:[30,31],Volume:[1,2]});});
  try {
    const load=(time:string)=>cachedHistory(broker,root,'9001','TSE','2026-01-05','2026-01-05',`2026-01-05T${time}+08:00`,new AbortController().signal);
    assert.equal((await load('09:10:00')).length,1);assert.equal((await load('09:11:00')).length,2);assert.equal(calls,1);
  }finally{await broker.close();store.close();rmSync(root,{recursive:true,force:true});}
});
test('the internal broker automatically avoids an occupied port without changing another service', async(t)=>{
  const other=createServer();
  try{await new Promise<void>((resolve,reject)=>{other.once('error',reject);other.listen(0,'127.0.0.1',resolve);});}
  catch(error){if(error instanceof Error&&'code' in error&&['EPERM','EACCES'].includes(String(error.code))){t.skip('This environment disables local sockets; Windows/Linux CI exercises this check.');return;}throw error;}
  try{const address=other.address();assert.ok(address&&typeof address!=='string');
    const origin=new URL(await brokerOrigin(address.port));assert.equal(origin.hostname,'127.0.0.1');assert.notEqual(Number(origin.port),address.port);
    assert.equal(other.listening,true);
  }finally{await new Promise<void>(resolve=>other.close(()=>resolve()));}
});
test('the bundled runtime rejects corruption, missing files and paths outside its own resources', async()=>{
  const root=mkdtempSync(join(tmpdir(),'broker-bundle-')),name=process.platform==='win32'?'shioaji.exe':'shioaji',path=join(root,name);
  const bytes=Buffer.from('isolated runtime fixture');writeFileSync(path,bytes);
  const manifest={version:'1.7.7',platform:process.platform,arch:process.arch,relative_path:name,sha256:createHash('sha256').update(bytes).digest('hex')};
  try{await assert.rejects(bundledShioajiPath(root),/內建 Shioaji/);
    writeFileSync(join(root,'runtime.json'),JSON.stringify(manifest));assert.equal(await bundledShioajiPath(root),path);
    writeFileSync(path,'corrupted');await assert.rejects(bundledShioajiPath(root),/內建 Shioaji/);
    writeFileSync(join(root,'runtime.json'),JSON.stringify({...manifest,relative_path:'../'+root.split(/[\\/]/).at(-1)+'/'+name}));
    // A resolved path within the resources is allowed; a genuinely external executable is rejected.
    const outside=join(tmpdir(),'outside-'+root.split(/[\\/]/).at(-1));writeFileSync(outside,bytes);
    try{writeFileSync(join(root,'runtime.json'),JSON.stringify({...manifest,relative_path:'../'+outside.split(/[\\/]/).at(-1)}));await assert.rejects(bundledShioajiPath(root),/內建 Shioaji/);}
    finally{rmSync(outside,{force:true});}
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('every simulation pane and activity stream stays in the replay scope, including after a report is restored', async()=>{
  const data=syntheticDataset('2026-01-05','2026-01-06');
  const report=await runBacktest({start:'2026-01-05',end:'2026-01-06',source:'sample',strategy:'rules'},data,SettingsSchema.parse({}),undefined,new AbortController().signal);
  const live=snapshot(),runtime={mode:'paper',account:live.account,quotes:[],features:live.features,metadata:{},plan:null,
    watch:{entries:[{symbol:'9999',name:'PRESENT_DAY_ONLY'}],changes:[],asof:'2026-10-10T00:00:00Z'},orders:live.account.open_orders,protections:[],decisions:[]} as unknown as RuntimeView;
  const state={runtime,backtest_result:report,backtest_progress:{running:false,phase:'COMPLETED'},replay:null,
    analyst_events:[{context:'live',asof:report.asof,stage:'RUNNING'},{context:'replay',asof:report.asof,stage:'DECISION'},
      {context:'replay',asof:'2099-01-01T00:00:00Z',stage:'FUTURE'}]} as unknown as DesktopState;
  const view=workspaceRuntime(state)!;assert.equal(workspaceCutoff(state),report.asof);assert.equal(view.account!.cash,report.metrics.final_cash);
  assert.deepEqual(view.account!.positions,report.positions);assert.deepEqual(view.quotes,[]);assert.deepEqual(view.features,{});assert.deepEqual(view.watch.entries,[]);
  assert.deepEqual(workspaceEvents(state).map(e=>e.stage),['DECISION']);
  state.runtime!.mode='live';assert.equal(workspaceRuntime(state),runtime);assert.deepEqual(workspaceEvents(state).map(e=>e.stage),['RUNNING']);
});
test('live strategy history divides its warmup into non-overlapping API windows of at most 30 dates',async()=>{
  const store=new Store(':memory:'),ranges:{start:string;end:string}[]=[];
  const broker=new ShioajiHttpBroker(store,SettingsSchema.parse({}),false,async(_input,init)=>{
    const body=JSON.parse(String(init?.body)) as {start:string;end:string};ranges.push(body);
    return Response.json({datetime:[body.start+'T09:10:00'],Open:[30],High:[31],Low:[29],Close:[30],Volume:[1]});
  });
  broker.instruments=async()=>({'9001':instrument()});
  try {
    const bars=await broker.history('9001',now);assert.equal(ranges.length,5);assert.equal(bars.length,5);
    assert.ok(ranges.every(r=>(Date.parse(r.end)-Date.parse(r.start))/86400000+1<=30));
    for(let i=1;i<ranges.length;i++)assert.equal(Date.parse(ranges[i]!.start)-Date.parse(ranges[i-1]!.end),86400000);
    assert.ok(bars.every(b=>b.date<'2026-10-08'));
  }finally{await broker.close();store.close();}
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
