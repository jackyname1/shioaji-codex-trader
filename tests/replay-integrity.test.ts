import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HistoricalMarket,syntheticDataset,validateDataset} from '../src/core/backtest-data.js';
import {conditionIssue} from '../src/core/conditions.js';
import {DecisionSchema,SettingsSchema,d,type Decision,type Features} from '../src/core/models.js';
import {CodexError,CodexAnalysisSchema,codexFailureKind,codexOutputSchema} from '../src/core/codex.js';
import {runBacktest,type ReplayFrame} from '../src/core/backtest.js';
import {demoAnalysis} from '../src/core/strategy.js';
import {cachedUniverse} from '../src/core/universe-cache.js';
import {ShioajiHttpBroker} from '../src/broker/http.js';
import {Store} from '../src/core/store.js';
import {TradingCalendar} from '../src/core/calendar.js';
import {Engine} from '../src/core/engine.js';
import {PaperBroker} from '../src/broker/paper.js';
import {roundTripEstimate} from '../src/core/execution.js';
import {now,quote,rig,testSize,instrument} from './helpers.js';
import {windowsProcessState} from '../src/core/store-process.js';

const day='2026-01-05',at=(time:string)=>new Date(`${day}T${time}:00+08:00`);
const decision:Decision={symbol:'9001',action:'BUY',shares:10,limit_price:'31',entry_when:'BELOW',trigger_price:'31',smart:{stop_price:'28',take_profit:'35',trailing_activate:null,trailing_fraction:null},reason:'完整條件',
  conditions:[{left:'LAST',operator:'GTE',right:'MA20',value:null},{left:'MA5',operator:'GTE',right:'MA20',value:null},{left:'LAST',operator:'GT',right:'VALUE',value:'29'}]};
const features:Features={sufficient:true,sessions:60,asof:'2026-01-02',ma5:30,ma20:30};
const flat=()=>{const data=syntheticDataset(day,'2026-01-06');for(const p of data.points){p.open=p.high=p.low=p.close='30';p.volume_shares=1000000;}return data;};

test('all structured guards must pass, including equality; missing, nonfinite and future indicators fail closed',()=>{
  assert.equal(conditionIssue(decision,quote(at('10:00')),features,at('10:00')),'');
  assert.match(conditionIssue(decision,{...quote(),last:'29.95'},features,at('10:00')),/未成立.*MA20/);
  for(const f of [undefined,{...features,ma20:undefined},{...features,ma20:NaN},{...features,sufficient:false},{...features,asof:day},{...features,asof:'2026-01-06'}])
    assert.match(conditionIssue(decision,quote(),f,at('10:00')),/資料未就緒/);
  assert.equal(conditionIssue({...decision,conditions:[]},quote(),undefined,at('10:00')),'');
  assert.equal(conditionIssue(decision,quote(),{...features,asof:day},at('14:00')),'');
  assert.throws(()=>DecisionSchema.parse({...decision,conditions:[{left:'LAST',operator:'GTE',right:'VALUE',value:null}]}));
  assert.throws(()=>DecisionSchema.parse({...decision,conditions:[{left:'LAST',operator:'GTE',right:'MA20',value:'30'}]}));
  assert.throws(()=>DecisionSchema.parse({...decision,conditions:[{left:'SHELL',operator:'GTE',right:'VALUE',value:'30'}]}));
  const schema=codexOutputSchema(DecisionSchema) as {required:string[]};assert.ok(schema.required.includes('conditions'));
  assert.ok(DecisionSchema.parse({...decision,conditions:undefined}),'Legacy plans remain readable');
  const analysis={snapshot_id:'fixture',expires_at:at('11:00').toISOString(),stance:'BUY_ALLOWED',candidates:['9001'],decisions:[decision],summary:'fixture',screening:null};
  assert.ok(CodexAnalysisSchema.parse(analysis));
  assert.throws(()=>CodexAnalysisSchema.parse({...analysis,decisions:[{...decision,conditions:null}]}),/conditions/);
  assert.throws(()=>CodexAnalysisSchema.parse({...analysis,decisions:[{...decision,conditions:undefined}]}),/conditions/);
});
test('extra conditions block before requesting quantity and are rechecked after a model reply',async()=>{
  const r=await rig();try{
    r.engine.setSettings({...r.s,codex_enabled:true});
    r.engine.plan!.analysis.decisions[0]!.conditions=[{left:'LAST',operator:'GTE',right:'VALUE',value:'30'}];
    r.market.marketPrice='29.95';await r.engine.tick(now);
    assert.equal(r.engine.pendingExecutions.size,0);assert.match(r.engine.decisionStates.get('9001')!.reason,/條件未成立/);
    r.market.marketPrice='30';await r.engine.tick(now);const id=r.engine.nextExecutionId()!;assert.ok(id);
    const input=(await r.engine.executionRequest(id,now))!,advice=await testSize(input);
    r.market.marketPrice='29.95';assert.equal(await r.engine.confirmExecution(id,advice,now),false);
    assert.equal(r.store.orders().length,0);assert.match(r.engine.decisionStates.get('9001')!.reason,/條件未成立/);
  }finally{await r.engine.close();r.store.close();}
});
test('postmarket history includes the completed current day without changing today\'s reference or revealing future rows',async()=>{
  const data=flat(),market=new HistoricalMarket(data,'0.01');
  assert.equal((await market.history('9001',at('13:30'))).at(-1)!.date,'2026-01-02');
  assert.equal((await market.history('9001',at('14:00'))).at(-1)!.date,day);
  const opening=await market.instruments(['9001'],at('10:00')),review=await market.instruments(['9001'],at('14:00'));
  assert.equal(review['9001']!.reference,opening['9001']!.reference);
  const withoutClose={...data,points:data.points.filter(p=>!(p.symbol==='9001'&&p.at===at('13:30').toISOString()))};
  assert.equal((await new HistoricalMarket(withoutClose,'0.01').history('9001',at('14:00'))).at(-1)!.date,'2026-01-02');
  const late={...data,points:[...data.points,{...data.points.find(p=>p.symbol==='9001')!,at:at('15:00').toISOString(),close:'35',high:'35'}]};
  const future=new HistoricalMarket(validateDataset(late),'0.01');
  assert.equal((await future.history('9001',at('14:00'))).at(-1)!.date,'2026-01-02');
});
test('daily historical membership hides future entrants, allows them on their day, and retains access to exited holdings',async()=>{
  const data=flat();data.daily_universe={[day]:{asof:'2026-01-02',symbols:['9001']},'2026-01-06':{asof:day,symbols:['9002']}};
  const market=new HistoricalMarket(validateDataset(data),'0.01');
  assert.deepEqual((await market.discover(40,at('10:00'))).map(c=>c.symbol),['9001']);
  assert.deepEqual((await market.discover(40,new Date('2026-01-06T10:00:00+08:00'))).map(c=>c.symbol),['9002']);
  assert.deepEqual(await market.discover(40,new Date('2026-01-07T10:00:00+08:00')),[]);
  assert.ok((await market.instruments(['9001'],new Date('2026-01-06T10:00:00+08:00')))['9001']);
  assert.throws(()=>validateDataset({...data,daily_universe:{[day]:{asof:day,symbols:['9001']}}}),/未來資料/);
});
test('an intraday indicator cache does not leak into the postmarket strategy snapshot',async()=>{
  const store=new Store(':memory:'),calendar=new TradingCalendar(store,true),s=SettingsSchema.parse({mode:'demo'}),market=new HistoricalMarket(flat(),'0.01');
  const engine=new Engine(store,new PaperBroker(store,market,s,calendar),s,calendar);
  try{await engine.start(at('10:00'));
    const morning=await engine.snapshot(at('10:00')),review=await engine.snapshot(at('14:00'),true);
    assert.equal(morning.features['9001']!.asof,'2026-01-02');assert.equal(review.features['9001']!.asof,day);
    assert.equal(review.review_only,true);assert.equal(review.features['9001']!.sessions,morning.features['9001']!.sessions+1);
  }finally{await engine.close();store.close();}
});
test('the readonly live history adapter includes the current day only after a closing bar, without polling it intraday',async()=>{
  const store=new Store(':memory:');let hasClose=true;const ranges:{start:string;end:string}[]=[];
  const broker=new ShioajiHttpBroker(store,SettingsSchema.parse({}),false,async(_input,init)=>{
    const range=JSON.parse(String(init?.body));ranges.push(range);
    const clocks=range.end===day&&!hasClose?['10:00']:['10:00','13:30'];
    return Response.json({datetime:clocks.map(t=>range.end+'T'+t+':00'),Open:clocks.map(()=>30),High:clocks.map(()=>31),Low:clocks.map(()=>29),Close:clocks.map(()=>30),Volume:clocks.map(()=>1000)});
  });broker.instruments=async()=>({'9001':instrument()});
  try{
    const morning=await broker.history('9001',at('10:00'));assert.ok(morning.every(b=>b.date<day));assert.ok(ranges.every(r=>r.end<day));
    assert.equal((await broker.history('9001',at('14:00'))).at(-1)!.date,day);
    hasClose=false;assert.ok((await broker.history('9001',at('14:00'))).every(b=>b.date<day));
  }finally{await broker.close();store.close();}
});
test('past-date scanner cache avoids repeated API traffic; date-mismatched responses cannot populate it',async()=>{
  const root=mkdtempSync(join(tmpdir(),'universe-')),store=new Store(':memory:');let calls=0;
  const broker=new ShioajiHttpBroker(store,SettingsSchema.parse({}),false,async(_input,init)=>{
    calls++;const body=JSON.parse(String(init?.body));return Response.json([{code:body.date==='2026-01-02'?'9001':'9002',name:'fixture',close:30,total_amount:100000000,date:body.date==='2026-01-06'?'2026-01-07':body.date}]);
  });
  try{
    const signal=new AbortController().signal;
    assert.equal((await cachedUniverse(broker,root,'2026-01-02',signal))[0]!.code,'9001');
    await cachedUniverse(broker,root,'2026-01-02',signal);assert.equal(calls,1);
    assert.equal((await cachedUniverse(broker,root,day,signal))[0]!.code,'9002');assert.equal(calls,2);
    await assert.rejects(cachedUniverse(broker,root,'2026-01-06',signal),/日期不符/);
  }finally{await broker.close();store.close();rmSync(root,{recursive:true,force:true});}
});
test('quota or rate limit halts at the failed strategy, writes a partial checkpoint and makes no further model requests',async()=>{
  for(const kind of ['QUOTA','RATE_LIMIT'] as const){let calls=0;const frames:ReplayFrame[]=[];
    const r=await runBacktest({start:day,end:'2026-01-06',source:'sample',strategy:'codex'},flat(),SettingsSchema.parse({codex_enabled:true}),async()=>{
      calls++;throw new CodexError(kind==='QUOTA'?'Codex 額度不足':'Codex 限流',kind);
    },new AbortController().signal,undefined,undefined,f=>frames.push(f),undefined,testSize);
    assert.equal(calls,1);assert.equal(r.status,'PARTIAL');assert.equal(r.quality.halted_at,r.asof);
    assert.equal(r.quality.halt_reason,kind==='QUOTA'?'CODEX_QUOTA':'CODEX_RATE_LIMIT');assert.equal(r.fills.length,0);
    assert.ok(frames.every(f=>f.at<=r.asof));assert.equal(r.daily_equity.at(-1)!.complete,false);
    assert.equal(r.metrics.codex_calls,1);assert.equal(r.strategy_log.length,0);assert.equal(r.quality.processed_sessions,1);
  }
  assert.equal(codexFailureKind(new Error('insufficient_quota')),'QUOTA');assert.equal(codexFailureKind(new Error('429 Too many requests')),'RATE_LIMIT');
});
test('quota during quantity confirmation never bypasses the second turn or retries subsequent symbols',async()=>{
  let sizes=0;const config=SettingsSchema.parse({codex_enabled:true});
  const r=await runBacktest({start:day,end:'2026-01-06',source:'sample',strategy:'codex'},flat(),config,async s=>demoAnalysis(s,config,new Date(s.asof)),new AbortController().signal,
    undefined,undefined,undefined,undefined,async()=>{sizes++;throw new CodexError('Codex 額度不足');});
  assert.equal(sizes,1);assert.equal(r.status,'PARTIAL');assert.equal(r.orders.length,0);assert.equal(r.fills.length,0);
  assert.equal(r.quality.halt_reason,'CODEX_QUOTA');assert.deepEqual(r.final_frame!.execution_queue,[]);
});
test('cost estimates account for minimum fees and tax, and reports reconcile gross minus all costs to net equity PnL',async()=>{
  const s=SettingsSchema.parse({risk_slippage_fraction:'0'}),small=roundTripEstimate(11,'659','673',s);
  assert.equal(small.estimated_total_costs,'63');assert.equal(small.estimated_net_target_gain,'91');
  assert.equal(roundTripEstimate(1,'659','673',s).estimated_net_target_gain,'-29');
  assert.equal(roundTripEstimate(11,'659',null,s).estimated_net_target_gain,null);
  const r=await runBacktest({start:day,end:'2026-01-06',source:'sample',strategy:'demo'},flat(),s,undefined,new AbortController().signal);
  assert.ok(d(r.metrics.gross_pnl!).minus(r.metrics.total_costs!).eq(r.metrics.net_pnl));
  assert.ok(d(r.metrics.total_costs!).eq(d(r.metrics.fees).plus(r.metrics.taxes)));assert.equal(r.quality.execution_model,'APPROXIMATE');
});
test('the current Windows PID is proven alive without a PowerShell probe or unsafe stale-lock evidence',()=>{
  assert.deepEqual(windowsProcessState(process.pid),{state:'running'});
});
