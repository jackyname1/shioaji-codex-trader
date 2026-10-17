import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/core/store.js';
import type {PortfolioState} from '../src/core/portfolio-risk.js';
import {spawnSync} from 'node:child_process';
import {compactSnapshot} from '../src/core/prompt-input.js';
import {SettingsSchema} from '../src/core/models.js';
import {HistoricalMarket,csvDataset} from '../src/core/backtest-data.js';
import {appendReplayActivity} from '../src/core/backtest-controller.js';
import type {AnalystEvent} from '../src/core/codex.js';
import {researchExit,evaluate,updateProtection} from '../src/core/smart.js';
import {snapshot,rig,now,testSize} from './helpers.js';
test('Python transaction audit verifies FIFO, missing inventory, chronology and complete private exports',()=>{
 const result=spawnSync(process.platform==='win32'?'python':'python3',['tests/audit-history.test.py'],{encoding:'utf8'});
 assert.equal(result.status,0,result.stdout+result.stderr);
});
test('optional prompt compaction preserves all numerical fields, instruments, quotes, holdings and hard limits',()=>{
 const s=snapshot();s.experience={scope:'demo',asof:s.asof,sample_count:1,realized_pnl:'-20',limitations:['a','a'],
  observations:[{at:s.asof,kind:'SIMULATED_FILL',symbol:'9001',action:'SELL',shares:10,price:'100',fee:'20',tax:'3',realized_pnl:'-20',note:'long text '.repeat(300)}],
  reviews:[{at:s.asof,summary:'review '.repeat(1000),sample_count:1}]};
 const original=JSON.stringify(s),c=compactSnapshot(s);
 assert.ok(JSON.stringify(c).length<original.length/2);assert.equal(JSON.stringify(s),original);
 for(const k of ['account','features','hard_limits','instruments','quotes','existing_protection'] as const)assert.deepEqual(c[k],s[k]);
 const {note:_note,...before}=s.experience.observations[0]!,{note:_after,...after}=c.experience!.observations[0]!;assert.deepEqual(after,before);
});
test('exported replay events preserve fill/order identity and exact trigger context',()=>{
 const es:AnalystEvent[]=[];const fill={id:'f',order_id:'o',price:'99.5',fee:'20',tax:'3'};
 appendReplayActivity(es,{at:now.toISOString(),stage:'FILL',message:'fill',order_id:'o',details:{fill}});
 assert.deepEqual((es[0]!.details as {fill:unknown}).fill,fill);assert.equal((es[0]!.details as {order_id:string}).order_id,'o');
});
test('daily approximate books do not invent liquidity at price limits or across unresolved actions; current close stays hidden at open',async()=>{
 const data=csvDataset('symbol,date,open,high,low,close,volume_shares\n9001,2026-01-02,100,100,100,100,270000\n9001,2026-01-05,110,110,110,110,1000000');
 const market=new HistoricalMarket(data,'0.01');await market.subscribe(['9001'],false);
 const q=market.quotes(new Date('2026-01-05T09:10:00+08:00'))[0]!;assert.equal(q.ask_shares,0);assert.equal(q.book_source,'APPROXIMATE');
 data.points[1]!.corporate_action=true;const blocked=new HistoricalMarket(data,'0.01');await blocked.subscribe(['9001'],false);
 assert.equal(blocked.quotes(new Date('2026-01-05T09:10:00+08:00')).length,0);
});
test('fixed and ATR exit hypotheses remain explicit and all protection floors only tighten through price gaps',()=>{
 const base=SettingsSchema.parse({mode:'paper'}),spec={stop_price:'95',take_profit:'115',trailing_activate:null,trailing_fraction:null};
 const fixed=researchExit(spec,'100',3,{...base,research_exit_mode:'fixed'}),trail=researchExit(spec,'100',3,{...base,research_exit_mode:'atr_trail'});
 assert.equal(fixed.take_profit,'115');assert.equal(fixed.trailing_fraction,null);assert.equal(trail.take_profit,null);assert.equal(trail.reward_target,'115');
 const p=updateProtection(undefined,'9001',trail,'a');evaluate(p,'115','2026-01-02T02:00:00Z');const floor=Number(p.protected_floor);
 evaluate(p,'116','2026-01-02T02:01:00Z');assert.ok(Number(p.protected_floor)>=floor);
 assert.ok(evaluate(p,'90','2026-01-05T01:10:00Z'));assert.ok(Number(p.protected_floor)>=floor);
});
test('a drawdown arising during quantity confirmation is checked again before any persisted intent',async()=>{
 const r=await rig();try{
  const features=Object.fromEntries(Array.from({length:5},(_,i)=>[String(9001+i),{sufficient:true,sessions:80,asof:'2026-10-07',ma5:30,ma20:29,ma60:28,last_close:30,atr14:1}]));
  r.engine.setSettings({...r.s,codex_enabled:true,portfolio_risk_enabled:true});Object.assign(r.engine.watchFeatures,features);
  await r.engine.tick(now);const id=r.engine.nextExecutionId()!;assert.ok(id);const req=await r.engine.executionRequest(id,now);assert.ok(req);
  const advice=await testSize(req),read=r.broker.account.bind(r.broker);
  r.broker.account=async at=>({...await read(at),cash:'95000'});
  assert.equal(await r.engine.confirmExecution(id,advice,now),false);assert.equal(r.store.orders().length,0);
  assert.match(r.engine.decisionStates.get('9001')!.reason,/組合高點回撤/);
 }finally{await r.engine.close();r.store.close();}
});

test('persistent high-water state survives closing and reopening the trading journal without resetting the account',async()=>{
 const root=mkdtempSync(join(tmpdir(),'hwm-')),path=join(root,'journal.db');
 let r=await rig(new Store(path));try{
  r.engine.portfolioRisk(now);const state=r.store.get<PortfolioState>('portfolio_risk_v1')!;state.high_water='120000';r.store.set('portfolio_risk_v1',state);
  await r.engine.close();r.store.close();r=await rig(new Store(path));
  assert.equal(r.engine.portfolioRisk(now)!.state.high_water,'120000');assert.equal(r.engine.account!.cash,'100000');
 }finally{await r.engine.close();r.store.close();rmSync(root,{recursive:true,force:true});}
});

test('settlement uses announced closures only after their cutoff and waits until the new due day at 11:00',async()=>{
 const {TradingCalendar}=await import('../src/core/calendar.js');const {PaperBroker,SyntheticMarket}=await import('../src/broker/paper.js');
 const store=new Store(':memory:');try{
 const cal=new TradingCalendar(store),cfg=SettingsSchema.parse({mode:'paper'});
 store.saveSessions(['2024-07-22','2024-07-23','2024-07-24','2024-07-25','2024-07-26'].map(day=>({day,open:true,settlement_open:true,source:'SYNTHETIC fixture',verified_at:'2024-01-01T00:00:00Z'})));
 for(const day of ['2024-07-24','2024-07-25'])store.saveSessions([{day,open:false,settlement_open:false,scheduled_open:true,scheduled_settlement_open:true,known_at:'2024-07-23T21:00:00+08:00',source:'SYNTHETIC announcement',verified_at:'2024-07-23T21:00:00+08:00'}]);
 cal.setAsOf(new Date('2024-07-22T10:00:00+08:00'));assert.equal(cal.nextSettlement(cal.nextSettlement('2024-07-22')),'2024-07-24');
 store.set('paper_ledger',{cash:'100',lots:[],orders:[],lastEvents:{},charges:{},fills:[],credits:[{due:'2024-07-24',amount:'5000',sold_day:'2024-07-22'}]});
 const broker=new PaperBroker(store,new SyntheticMarket(),cfg,cal,true);
 assert.equal((await broker.account(new Date('2024-07-25T12:00:00+08:00'))).cash,'100');
 assert.equal((await broker.account(new Date('2024-07-26T10:59:00+08:00'))).cash,'100');
 assert.equal((await broker.account(new Date('2024-07-26T11:00:00+08:00'))).cash,'5100');
 assert.throws(()=>cal.nextSettlement('2024-12-31'),/交割行事曆/);
 }finally{store.close();}
});
