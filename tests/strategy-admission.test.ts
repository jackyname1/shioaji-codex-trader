import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {ThreadEvent} from '@openai/codex-sdk';
import {decisionDeadline,mayRetainStrategy,StrategyValidationError} from '../src/core/strategy-admission.js';
import {validateAnalysis,demoAnalysis} from '../src/core/strategy.js';
import {CodexAnalyst,CodexError,diagnoseCodexFailure,type Runner} from '../src/core/codex.js';
import {runBacktest,type ReplayFrame} from '../src/core/backtest.js';
import {backtestExport} from '../src/core/backtest-export.js';
import {syntheticDataset} from '../src/core/backtest-data.js';
import {SettingsSchema,twDay,twClock,type Analysis,type Snapshot} from '../src/core/models.js';
import {now,settings,snapshot,rig} from './helpers.js';

const code=(expected:string)=>(error:unknown)=>error instanceof StrategyValidationError&&error.code===expected;
test('September 9 expired reply has a specific diagnostic and cannot activate',()=>{
  const at=new Date('2026-09-09T09:15:00+08:00'),input={...snapshot(),asof:at.toISOString()},s=settings();
  const proposal={...demoAnalysis(input,s,at),expires_at:'2026-09-09T07:15:00+08:00'};
  assert.throws(()=>validateAnalysis(proposal,input,at,s),code('REPLY_EXPIRED'));
  try{validateAnalysis(proposal,input,at,s);}catch(error){
    assert.deepEqual(diagnoseCodexFailure(error),{kind:'OTHER',code:'REPLY_EXPIRED',validation_phase:'SEMANTIC'});
  }
});
test('July 22 02:15 UTC is 10:15 Taipei, admitted at 09:15 and never becomes a strategy deadline',()=>{
  const at=new Date('2026-07-22T09:15:00+08:00'),s=settings(),input={...snapshot(),asof:at.toISOString()};
  const p=validateAnalysis({...demoAnalysis(input,s,at),expires_at:'2026-07-22T02:15:00+00:00'},input,at,s);
  assert.equal(twClock(new Date(p.analysis.expires_at)),'10:15');assert.equal(p.lifecycle,'UNTIL_REPLACED');
});
test('reply time errors distinguish timezone, malformed date, expiry and server window',()=>{
  const s=settings(),input=snapshot(),a=demoAnalysis(input,s,now);
  for(const [expires_at,expected] of [
    ['2026-10-08T11:00:00','REPLY_TIMEZONE_REQUIRED'],['2026-13-08T11:00:00+08:00','REPLY_TIME_INVALID'],
    [now.toISOString(),'REPLY_EXPIRED'],[new Date(now.getTime()+(s.plan_max_minutes+1)*60000).toISOString(),'REPLY_DEADLINE_EXCEEDED'],
  ])assert.throws(()=>validateAnalysis({...a,expires_at},input,now,s),code(expected!));
  assert.throws(()=>validateAnalysis({...a,snapshot_id:'other'},input,now,s),code('SNAPSHOT_MISMATCH'));
  assert.throws(()=>validateAnalysis(a,{...input,asof:new Date(now.getTime()+1).toISOString()},now,s),code('SNAPSHOT_IN_FUTURE'));
  assert.throws(()=>validateAnalysis(a,input,new Date(now.getTime()+(s.codex_timeout_seconds+31)*1000),s),code('SNAPSHOT_STALE'));
});
test('response latency cannot extend a snapshot deadline and equivalent UTC/offset times agree',()=>{
  const s=SettingsSchema.parse({...settings(),plan_max_minutes:10}),input=snapshot(),at=new Date(now.getTime()+10000);
  const a={...demoAnalysis(input,s,now),expires_at:new Date(now.getTime()+605000).toISOString()};
  assert.throws(()=>validateAnalysis(a,input,at,s),code('REPLY_DEADLINE_EXCEEDED'));
  assert.equal(decisionDeadline(input,s),decisionDeadline({...input,asof:'2026-10-08T10:00:00+08:00'},s));
});
test('production model schema fixes the deadline to a program value and prompt requests an exact copy',async()=>{
  const s=SettingsSchema.parse({...settings(),codex_enabled:true}),input=snapshot(),answer=demoAnalysis(input,s,now);
  const run:Runner=async(prompt,options)=>{
    const schema=options.outputSchema as {properties:{expires_at:{const:string}}};
    assert.equal(schema.properties.expires_at.const,decisionDeadline(input,s));
    assert.ok(prompt.includes('decision_deadline_at'));assert.ok(prompt.includes('Asia/Taipei'));
    const events=[
      {type:'item.completed',item:{type:'agent_message',id:'reply',text:JSON.stringify(answer)}},
      {type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}},
    ] as ThreadEvent[];
    return {events:(async function*(){yield* events;})()};
  };
  await new CodexAnalyst(s,'/unused',run).analyze(input);
});
test('failed replacement preserves persisted strategy, protections, pending orders and entry block state',async()=>{
  const r=await rig();try{
    r.market.marketPrice='30.1';await r.engine.tick(now);
    const old=structuredClone(r.engine.plan!),protections=structuredClone(r.store.protections()),orders=structuredClone(r.store.orders());
    const input=await r.engine.snapshot(now),bad={...old.analysis,snapshot_id:input.snapshot_id,expires_at:now.toISOString()};
    await assert.rejects(r.engine.activate(bad,input,now),code('REPLY_EXPIRED'));
    assert.deepEqual(r.engine.plan,old);assert.deepEqual(r.store.plan(),old);
    assert.deepEqual(r.store.protections(),protections);assert.deepEqual(r.store.orders(),orders);
    assert.equal(r.engine.entryBlocked,false);
    assert.ok(mayRetainStrategy(old,new StrategyValidationError('REPLY_EXPIRED','test'),now));
    assert.equal(mayRetainStrategy(old,new Error('database failed'),now),false);
    assert.equal(mayRetainStrategy(old,new CodexError('network','NETWORK',{kind:'NETWORK',code:'STREAM_INTERRUPTED'}),now),false);
    assert.equal(mayRetainStrategy(undefined,new StrategyValidationError('REPLY_EXPIRED','test'),now),false);
  }finally{await r.engine.close();r.store.close();}
});
function proposal(s:Snapshot):Analysis {
  return {snapshot_id:s.snapshot_id,expires_at:new Date(Date.parse(s.asof)+3600000).toISOString(),stance:'BUY_ALLOWED',
    candidates:['9001'],screening:null,summary:'Synthetic admission regression',
    decisions:[{symbol:'9001',action:'BUY',shares:30,limit_price:'30',entry_when:'BELOW',trigger_price:'29.5',
      smart:{stop_price:'27',take_profit:'40',trailing_activate:null,trailing_fraction:null},conditions:[],reason:'Synthetic regression'}]};
}
test('September 9 rejected replacement keeps old conditions usable, protection and PARTIAL diagnostics through full replay',async()=>{
  const data=syntheticDataset('2026-09-08','2026-09-10');
  data.points=data.points.filter(p=>p.symbol==='9001'&&['09:10','10:00','10:10','13:30'].includes(twClock(new Date(p.at))));
  for(const p of data.points){const price=twDay(new Date(p.at))==='2026-09-09'?'29':'30';p.open=p.high=p.low=p.close=price;p.volume_shares=1000000;}
  const frames:ReplayFrame[]=[];
  const r=await runBacktest({start:'2026-09-08',end:'2026-09-10',source:'sample',strategy:'codex',strategy_every_sessions:1,
    strategy_schedule:'fixed',strategy_times:['09:15'],execution_sizing:'deterministic',entry_cadence:'market',max_codex_calls:3},data,
    SettingsSchema.parse({codex_enabled:true,auto_watchlist:false}),async s=>{
      const a=proposal(s);
      if(twDay(new Date(s.asof))==='2026-09-09')a.expires_at='2026-09-09T07:15:00+08:00';
      return a;
    },new AbortController().signal,undefined,undefined,f=>frames.push(f));
  assert.equal(r.status,'PARTIAL');assert.equal(r.quality.processed_sessions,3);
  assert.equal(r.failures!.length,1);assert.equal(r.failures![0]!.stage,'ACTIVATION');
  assert.equal(r.failures![0]!.diagnostic!.code,'REPLY_EXPIRED');
  assert.ok(!r.failures![0]!.issue.includes('歷史快照或策略驗證未完成'));
  assert.ok(r.fills.some(f=>f.action==='BUY'&&twDay(new Date(f.at))==='2026-09-09'));
  const before=frames.find(f=>twDay(new Date(f.at))==='2026-09-08'&&f.plan)?.plan;
  const after=frames.find(f=>twDay(new Date(f.at))==='2026-09-09'&&twClock(new Date(f.at))==='10:10')?.plan;
  assert.ok(before);assert.equal(after?.id,before.id);
  assert.ok(r.final_frame!.protections.some(p=>p.symbol==='9001'));
  assert.equal(r.diagnostics!.audit.passed,true);
  assert.equal(JSON.parse(backtestExport(r,'json').content).failures[0].diagnostic.code,'REPLY_EXPIRED');
});
test('an expired initial reply never creates any order and the replay is FAILED',async()=>{
  const data=syntheticDataset('2026-09-09','2026-09-09');
  const r=await runBacktest({start:'2026-09-09',end:'2026-09-09',source:'sample',strategy:'codex',strategy_schedule:'fixed',
    strategy_times:['09:15'],execution_sizing:'deterministic'},data,SettingsSchema.parse({codex_enabled:true}),
    async s=>({...proposal(s),expires_at:'2026-09-09T07:15:00+08:00'}),new AbortController().signal);
  assert.equal(r.status,'FAILED');assert.equal(r.orders.length,0);assert.equal(r.fills.length,0);
});

test('stale held-stock valuation makes a fully processed replay PARTIAL even if cash accounting balances',async()=>{
  const data=syntheticDataset('2026-09-08','2026-09-08');
  data.points=data.points.filter(p=>p.symbol!=='9001'||twClock(new Date(p.at))<='10:00');
  for(const p of data.points){p.open=p.high=p.low=p.close='30';p.volume_shares=1000000;}
  const r=await runBacktest({start:'2026-09-08',end:'2026-09-08',source:'sample',strategy:'codex',
    strategy_schedule:'fixed',strategy_times:['09:15'],execution_sizing:'deterministic'},data,
    SettingsSchema.parse({codex_enabled:true,auto_watchlist:false}),async s=>({
      ...proposal(s),decisions:proposal(s).decisions.map(d=>({...d,limit_price:'30.05',entry_when:'IMMEDIATE',trigger_price:'0'})),
    }),new AbortController().signal);
  assert.ok(r.fills.some(f=>f.action==='BUY'));
  assert.equal(r.diagnostics!.audit.passed,true);assert.equal(r.status,'PARTIAL');
  assert.ok(r.diagnostics!.audit.stale_valuation_symbols.includes('9001'));
  assert.ok(r.limitations.some(l=>l.includes('STALE_VALUATION')));
});
