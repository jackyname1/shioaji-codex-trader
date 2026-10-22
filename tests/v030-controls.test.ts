import test from 'node:test';
import assert from 'node:assert/strict';
import {confirmationIssues,admissionIssues,breadthState} from '../src/core/entry-policy.js';
import {deterministicAdvice} from '../src/core/execution.js';
import {clockConsensus,diagnoseClock} from '../src/core/clock-diagnostics.js';
import {diagnoseCodexFailure} from '../src/core/codex-failure.js';
import {SmartSchema,SettingsSchema,type Features} from '../src/core/models.js';
import {tableContext} from '../src/core/prompt-input.js';
import {assumedQuote} from '../src/core/fill-assumptions.js';
import {account,instrument,now,order,quote,rig,settings,snapshot} from './helpers.js';
import {TradingCalendar} from '../src/core/calendar.js';
import {Store} from '../src/core/store.js';
import {analysisPrompt} from '../src/core/codex.js';
import {HistoricalMarket,type HistoryDataset} from '../src/core/backtest-data.js';
const features:Features={sufficient:true,sessions:80,ma5:30,ma20:29,ma60:28,ma20_previous:28.9,atr14:1,volume_ratio20:1.3,last_close:30,previous_resistance20:29.9};
test('strategy instructions match the selected sizing authority and preserve valid HOLD protection',()=>{
  const s=snapshot();s.hard_limits.execution_sizing='deterministic';
  assert.match(analysisPrompt(s),/不會增加參考股數/);assert.doesNotMatch(analysisPrompt(s),/再呼叫 Codex 決定實際股數/);
  assert.match(analysisPrompt(s),/smart=null 保留既有保護/);
  s.hard_limits.execution_sizing='codex';assert.match(analysisPrompt(s),/再呼叫 Codex 決定實際股數/);
});
test('confirmed trend cannot buy below MA5, falling long trend or missing inputs; breakout uses preceding completed volume',()=>{
  assert.deepEqual(confirmationIssues('trend',features,quote()),[]);
  assert.match(confirmationIssues('trend',features,{...quote(),last:'29.5'}).join(),/MA5/);
  assert.match(confirmationIssues('trend',{...features,ma60:31},quote()).join(),/MA60/);
  assert.ok(confirmationIssues('trend',{sufficient:true,sessions:80},quote()).length);
  assert.ok(confirmationIssues('pullback',features,quote()).length);
  assert.deepEqual(confirmationIssues('breakout',features,quote()),[]);
  assert.ok(confirmationIssues('breakout',{...features,volume_ratio20:1.1},quote()).length);
  assert.equal(breadthState({'9001':features}),'UNKNOWN');
});
test('strict admission independently caps cooldown, additions, invalid stops, unknown correlated sectors and pending risk',()=>{
  const store=new Store(':memory:'),calendar=new TradingCalendar(store,true),s=SettingsSchema.parse({...settings(),entry_policy:'trend'});
  const f=Object.fromEntries(['9001','9002','9003','9004','9005'].map(k=>[k,features]));
  const check=(a=account(),spec={stop_price:'29',take_profit:'33',trailing_activate:null,trailing_fraction:null},lastSell?:string)=>admissionIssues(order(),a,s,spec,{9001:instrument()},f,quote(),undefined,calendar,now,lastSell,{'9002':'28'});
  try{
    assert.deepEqual(check(),[]);
    assert.match(check(account(),{stop_price:'0',take_profit:'33',trailing_activate:null,trailing_fraction:null}).join(),/有效進場停損/);
    assert.match(check(account(),undefined,'2026-10-07T02:00:00Z').join(),/冷卻/);
    const held={symbol:'9001',shares:1,sellable:1,average_price:'31',last_price:'30'};
    assert.match(check({...account(),positions:[held]}).join(),/禁止同股加碼/);
    assert.match(check({...account(),orders:[order({local_id:'other',symbol:'9002',shares:500,limit_price:'30'})]}).join(),/組合估計損失/);
    assert.match(check({...account(),positions:[{...held,symbol:'9002',shares:2000}]}).join(),/產業/);
  }finally{store.close();}
});
test('deterministic sizing caps a 30-share reference even if broker risk permits 32, submits once and persists protection',async()=>{
  const r=await rig();try{
    r.engine.setSettings({...r.s,codex_enabled:true,execution_sizing:'deterministic'});
    await r.engine.tick(now);assert.equal(r.engine.pendingExecutions.size,0);
    assert.equal(r.store.orders().length,1);assert.equal(r.store.orders()[0]!.shares,30);
    await r.engine.tick(new Date(now.getTime()+3000));assert.equal(r.store.orders().length,1);
    assert.equal(r.store.protections()[0]!.spec.stop_price,'29');
  }finally{await r.engine.close();r.store.close();}
});
test('cost-invalid deterministic quantities never round up to meet minimum fee economics',()=>{
  const r={request_id:'r',symbol:'9001',action:'BUY',condition:{shares:30},protection:{stop_price:'29',take_profit:'30.1',reward_target:'30.1'},lots:[{lot:'ODD',step:1,min_shares:1,max_shares:32,limit_price:'30'}]} as unknown as Parameters<typeof deterministicAdvice>[0];
  assert.equal(deterministicAdvice(r,SettingsSchema.parse({...settings(),min_entry_reward_risk:'1.2'})).action,'HOLD');
});
test('a known invalid confirmation is rejected before creating any paid-model sizing request',async()=>{
  const r=await rig();try{
    r.engine.setSettings({...r.s,codex_enabled:true,execution_sizing:'codex',entry_policy:'trend'});
    r.engine.watchFeatures=Object.fromEntries(['9001','9002','9003','9004','9005'].map(s=>[s,{...features,ma5:31}]));
    await r.engine.tick(now);
    assert.equal(r.engine.pendingExecutions.size,0);assert.equal(r.store.orders().length,0);
    assert.match(r.engine.decisionStates.get('9001')!.reason,/MA5/);
    assert.ok(r.store.logs().some(l=>l.includes('未呼叫數量模型')));
  }finally{await r.engine.close();r.store.close();}
});
test('confirmed rebound preserves its actual entry condition through deterministic sizing and final admission',async()=>{
  const r=await rig();try{
    r.engine.setSettings({...r.s,codex_enabled:true,execution_sizing:'deterministic',entry_policy:'pullback'});
    r.engine.watchFeatures=Object.fromEntries(['9001','9002','9003','9004','9005'].map(s=>[s,{...features}]));
    Object.assign(r.engine.plan!.analysis.decisions[0]!,{entry_when:'REBOUND',trigger_price:'30',limit_price:'31',rebound_fraction:'0.01'});
    await r.engine.tick(now);assert.equal(r.store.orders().length,0);
    r.market.marketPrice='30.6';await r.engine.tick(new Date(now.getTime()+3000));
    assert.equal(r.store.orders().length,1,JSON.stringify([...r.engine.decisionStates]));assert.equal(r.store.orders()[0]!.shares,30);
  }finally{await r.engine.close();r.store.close();}
});
test('invalid semantic protection reports only safe schema paths, preserving strict rejection',()=>{
  const result=SmartSchema.safeParse({stop_price:'30',take_profit:null,trailing_activate:null,trailing_fraction:null,reward_target:'30'});
  assert.equal(result.success,false);if(result.success)return;
  const diagnostic=diagnoseCodexFailure(result.error);assert.equal(diagnostic.validation_phase,'SEMANTIC');assert.equal(diagnostic.code,'INVALID_OUTPUT');
  assert.equal(diagnoseCodexFailure(new SyntaxError('PRIVATE text')).validation_phase,'JSON');assert.ok(!JSON.stringify(diagnostic).includes('收益'));
});
test('columnar context preserves all fields and numbers without substituting zero for missing values',()=>{
  const input=snapshot();input.features={'9001':features,'9002':{sufficient:false,sessions:3}};
  const table=tableContext(input).features as {columns:string[];rows:unknown[][]};
  for(const [symbol,f] of Object.entries(input.features)){const row=table.rows.find(row=>row[0]===symbol)!;
    for(const [key,value] of Object.entries(f))assert.equal(row[table.columns.indexOf(key)],value);}
  assert.deepEqual(tableContext(input).account,input.account);assert.deepEqual(tableContext(input).hard_limits,input.hard_limits);
});
test('approximate fill assumptions reduce liquidity and conservative daily data cannot invent volume; observed books are preserved',()=>{
  const q={...quote(),book_source:'APPROXIMATE' as const,bid_shares:10000,ask_shares:10000};
  assert.equal(assumedQuote(q,'neutral').ask_shares,1000);assert.equal(assumedQuote(q,'conservative',false).ask_shares,0);
  assert.ok(Number(assumedQuote(q,'neutral').ask)>Number(q.ask));
  assert.deepEqual(assumedQuote({...q,book_source:'OBSERVED'},'conservative',false),{...q,book_source:'OBSERVED'});
});
test('common-lot observed depth cannot appear as an observed odd-lot queue or duplicate its full volume budget',async()=>{
  const point={symbol:'9001',at:'2026-01-02T05:30:00.000Z',open:'30',high:'30',low:'30',close:'30',volume_shares:100000};
  const current={...point,at:'2026-01-05T01:10:00.000Z',bid:'29',ask:'31',bid_shares:5000,ask_shares:5000,book_lot:'COMMON' as const};
  const data:HistoryDataset={source:'SYNTHETIC',synthetic:true,frequency:'MINUTE',names:{},limitations:[],points:[point,current]};
  const market=new HistoricalMarket(data,'0.01');await market.subscribe(['9001'],true);
  const quotes=market.quotes(new Date(current.at)),odd=quotes.find(q=>q.odd)!,common=quotes.find(q=>!q.odd)!;
  assert.equal(common.book_source,'OBSERVED');assert.equal(common.ask_shares,5000);
  assert.equal(odd.book_source,'APPROXIMATE');assert.equal(odd.ask_shares,500);assert.equal(odd.ask,'30.05');
});
test('clock checks require agreeing independent sources and never treat failed TLS requests as a zero offset',async()=>{
  const sample=(source:string,offset_ms:number)=>({source,offset_ms,uncertainty_ms:600,rtt_ms:200});
  assert.equal(clockConsensus([sample('a',20000),sample('b',20100)]).status,'DRIFT');
  assert.equal(clockConsensus([sample('a',0),sample('b',15000)]).status,'UNKNOWN');
  assert.equal(clockConsensus([sample('a',0),sample('a',0)]).status,'UNKNOWN');
  let calls=0;const report=await diagnoseClock((async()=>{calls++;throw Error('TLS failure PRIVATE');}) as typeof fetch);
  assert.equal(calls,3);assert.equal(report.status,'UNKNOWN');assert.equal(report.offset_ms,null);assert.ok(!JSON.stringify(report).includes('PRIVATE'));
});
