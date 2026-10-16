import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SettingsSchema,d,equity,type Plan,type Features,type Quote} from '../src/core/models.js';
import {adaptProtection,evaluate,trailingExit,trackEntry,updateProtection} from '../src/core/smart.js';
import {multiOpportunity} from '../src/core/opportunities.js';
import {roundTripEstimate,entryRiskIssues} from '../src/core/costs.js';
import {tradeStatistics,waitCategory} from '../src/core/performance.js';
import {validateAnalysis} from '../src/core/strategy.js';
import {PaperBroker} from '../src/broker/paper.js';
import {TradingCalendar,applyCalendarExceptions,parseCalendar} from '../src/core/calendar.js';
import {Store} from '../src/core/store.js';
import {Engine} from '../src/core/engine.js';
import {runBacktest} from '../src/core/backtest.js';
import {syntheticDataset} from '../src/core/backtest-data.js';
import {account,quote,order,now,snapshot,rig,ControlledMarket} from './helpers.js';

const s=SettingsSchema.parse({mode:'demo',auto_execute:true,max_order_fraction:'0.20',min_cash_fraction:'0.20',max_symbol_fraction:'0.25',
  max_exposure_fraction:'0.80',target_exposure_fraction:'0.70',max_daily_buy_fraction:'0.60',min_entry_reward_risk:'1.2',max_trade_risk_fraction:'0.0125'});
const f:Features={sufficient:true,sessions:100,ma5:99,ma20:97,ma20_previous:96,ma60:90,rsi14:55,atr14:3,volume_ratio20:1.2,
  support20:88,resistance20:120,return20:.08};
const p:Plan={id:'multi',created_at:now.toISOString(),analysis:{snapshot_id:'s',expires_at:new Date(now.getTime()+180*60000).toISOString(),
  candidates:['9001'],decisions:[],stance:'BUY_ALLOWED',summary:'test',screening:{min_amount:'0',min_volume_ratio:'0.7',rsi_min:30,rsi_max:75,return20_min:'-0.05',
    entry:{signal:'MULTI',allocation_fraction:'0.20',max_ma20_distance:'0.10',stop_fraction:'0.05',take_profit_fraction:'0.10',trailing_fraction:'0.03'}}}};
const q=(last='100',minute=0):Quote=>({...quote(new Date(now.getTime()+minute*60000)),last,bid:d(last).minus('.5').toFixed(),ask:d(last).plus('.5').toFixed(),bid_shares:999,ask_shares:999});

test('v023 trend continues without waiting for a pullback and sizes final quantity within fee/slippage risk',()=>{
  const result=multiOpportunity(p,'9001',f,q(),account(),s,now);assert.equal(result.signal,'TREND');assert.ok(result.decision);
  const decision=result.decision;assert.deepEqual(entryRiskIssues(decision.shares,decision.limit_price,decision.smart!,account(),s),[]);
  assert.ok(d(decision.limit_price).times(decision.shares).lte(equity(account()).times(s.max_order_fraction)));
  assert.equal(decision.smart!.reward_target,'120');
});
test('v023 rejects missing MA60, overheated trend, unsupported volume and a target below the executable ask',()=>{
  for(const changes of [{ma60:undefined},{rsi14:90},{volume_ratio20:.1},{resistance20:100}]){
    const result=multiOpportunity(p,'9001',{...f,...changes},q(),account(),s,now);assert.equal(result.decision,undefined);
  }
});
test('v023 breakout requires volume and bounds chase distance without inventing an RR target',()=>{
  const b={...f,ma20:118,ma20_previous:117,ma5:120,ma60:110,resistance20:120,support20:100};
  const result=multiOpportunity(p,'9001',b,q('121'),account(),s,now);assert.equal(result.signal,'BREAKOUT20');
  assert.equal(result.decision!.smart!.reward_target,'140');
  assert.notEqual(multiOpportunity(p,'9001',{...b,volume_ratio20:.8},q('121'),account(),s,now).signal,'BREAKOUT20');
  assert.notEqual(multiOpportunity(p,'9001',b,q('125'),account(),s,now).signal,'BREAKOUT20');
});
test('v023 recent completed breakout continuation uses an unchanged measured range target at different executable prices',()=>{
  const features={...f,breakout_base20:95,breakout_range20:25,last_close:100,resistance20:103};
  const a=multiOpportunity(p,'9001',features,q('100'),account(),s,now),b=multiOpportunity(p,'9001',features,q('101'),account(),s,now);
  assert.equal(a.signal,'TREND');assert.equal(b.signal,'TREND');assert.equal(a.decision!.smart!.reward_target,'120');assert.equal(b.decision!.smart!.reward_target,'120');
});
test('v023 pullback records the actual low across quote updates, confirms recovery, times out and restarts only with a new plan',()=>{
  let r=multiOpportunity(p,'9001',f,q('97'),account(),s,now);assert.ok(r.track?.armed);assert.equal(r.decision,undefined);
  r=multiOpportunity(p,'9001',f,q('96',1),account(),s,new Date(now.getTime()+60000),r.track);assert.equal(r.track!.low_water,'96');
  r=multiOpportunity(p,'9001',f,q('97',2),account(),s,new Date(now.getTime()+120000),r.track);assert.equal(r.signal,'PULLBACK20');
  const expired=multiOpportunity(p,'9001',f,q('97',100),account(),s,new Date(now.getTime()+6000000),r.track);
  assert.equal(expired.track!.status,'EXPIRED');assert.equal(expired.decision,undefined);
  const restarted=multiOpportunity({...p,id:'new'},'9001',f,q('97',101),account(),s,new Date(now.getTime()+6060000),expired.track);
  assert.equal(restarted.track!.status,'TRACKING');
  const broken=multiOpportunity(p,'9001',f,q('90',3),account(),s,new Date(now.getTime()+180000),r.track);
  assert.equal(broken.track!.status,'INVALID');
});
test('v023 renewed signals may add within concentration limits, without open-order duplicates or forced allocations',()=>{
  const a=account();a.positions=[{symbol:'9001',shares:10,sellable:10,average_price:'90',last_price:'100'}];
  const add=multiOpportunity(p,'9001',f,q(),a,s,now).decision!;assert.ok(add);
  assert.ok(d(add.limit_price).times(add.shares).plus(1000).lte(equity(a).times(s.max_symbol_fraction)));
  a.orders=[order({symbol:'9001',status:'PENDING'})];assert.match(multiOpportunity(p,'9001',f,q(),a,s,now).reason,/去重/);a.orders=[];
  a.positions[0]!.shares=250;a.cash='75000';assert.match(multiOpportunity(p,'9001',f,q(),a,s,now).reason,/單檔上限/);
  a.positions=[];a.cash='100';a.settlement_credits='99900';assert.match(multiOpportunity(p,'9001',f,q(),a,s,now).reason,/交割/);
  a.cash='100000';a.settlement_credits='0';assert.equal(multiOpportunity(p,'9001',f,q(),a,{...s,min_net_profit_twd:'10000'},now).decision,undefined);
});
test('v023 slippage and overnight stress increase loss without increasing the target',()=>{
  const raw=roundTripEstimate(100,'100','120',{...s,risk_slippage_fraction:'0'},'95');
  const slipped=roundTripEstimate(100,'100','120',s,'95');
  assert.ok(d(slipped.estimated_stop_loss!).gt(raw.estimated_stop_loss!));
  assert.ok(d(slipped.estimated_net_target_gain!).lt(raw.estimated_net_target_gain!));assert.equal(slipped.target_price,'120');
  const issues=entryRiskIssues(100,'100',{stop_price:'95',take_profit:'120',trailing_activate:null,trailing_fraction:null},account(),
    {...s,overnight_gap_fraction:'0.10',max_gap_risk_fraction:'0.005'});assert.match(issues.join(),/跳空/);
});
test('v023 adaptive protection uses actual fee-inclusive cost, records highs before arming and never lowers its floor',()=>{
  const protection=updateProtection(undefined,'9001',{stop_price:'94',take_profit:'125',trailing_activate:null,trailing_fraction:null},'p');
  const position={symbol:'9001',shares:100,sellable:100,average_price:'100',last_price:'100',cost_basis:'10020'};
  adaptProtection(protection,position,2,s);evaluate(protection,'103',now.toISOString());assert.equal(protection.high_water,'103');
  adaptProtection(protection,position,2,s);evaluate(protection,'112',new Date(now.getTime()+1000).toISOString());
  adaptProtection(protection,position,2,s);assert.equal(protection.break_even_armed,true);assert.ok(d(protection.break_even_price!).gt(100));
  const floor=protection.protected_floor!;adaptProtection(protection,position,10,s);evaluate(protection,'111',new Date(now.getTime()+2000).toISOString());
  assert.ok(d(protection.protected_floor!).gte(floor));assert.ok(trailingExit(protection));
  assert.equal(evaluate(protection,'90',new Date(now.getTime()+3000).toISOString()),'STOP');
});
test('v023 protection floor, activation and exact cost survive SQLite restart and replacement plans',()=>{
  const dir=mkdtempSync(join(tmpdir(),'v023-state-')),path=join(dir,'state.db');let store=new Store(path);
  try{const protection=updateProtection(undefined,'9001',{stop_price:'94',take_profit:null,reward_target:'130',trailing_activate:'105',trailing_fraction:'.03'.replace('.','0.')},'a');
    evaluate(protection,'115',now.toISOString());store.saveProtection(protection);store.close();store=new Store(path);
    const restored=updateProtection(store.protections()[0],'9001',{stop_price:'90',take_profit:null,reward_target:'130',trailing_activate:null,trailing_fraction:null},'b');
    assert.equal(restored.high_water,'115');assert.equal(restored.trailing_armed,true);assert.ok(d(restored.protected_floor!).gte('111.55'));
    assert.equal(evaluate(restored,'110',new Date(now.getTime()+1000).toISOString()),'TRAILING');
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('v023 a held stock outside the ranked pool may be reviewed; an unknown candidate still fails closed',()=>{
  const input=snapshot();input.account.positions=[{symbol:'3324',shares:3,sellable:3,average_price:'100',last_price:'100'}];
  const a={snapshot_id:input.snapshot_id,expires_at:new Date(now.getTime()+60000).toISOString(),stance:'HOLD_ONLY',candidates:['3324'],
    decisions:[{symbol:'3324',action:'HOLD',shares:0,limit_price:'0',entry_when:'IMMEDIATE',trigger_price:'0',smart:null,reason:'held review'}],summary:'review'};
  assert.doesNotThrow(()=>validateAnalysis(a,input,now,s));assert.throws(()=>validateAnalysis({...a,candidates:['9999']},input,now,s),/資料範圍/);
});
test('v023 partial fills count as one completed round trip, with zero-loss profit factor kept explicit',()=>{
  const fill=(action:'BUY'|'SELL',shares:number,pnl:string|null)=>({id:'x',order_id:'x',at:now.toISOString(),symbol:'9001',action,lot:'ODD' as const,purpose:'ENTRY' as const,shares,price:'100',amount:'100',fee:'20',tax:'0',realized_pnl:pnl});
  const stats=tradeStatistics([fill('BUY',10,null),fill('SELL',4,'20'),fill('SELL',6,'30')]);
  assert.equal(stats.closed_trades,1);assert.equal(stats.win_rate_pct,'100.0000');assert.equal(stats.profit_factor,null);assert.equal(stats.profit_factor_unbounded,true);
  assert.equal(tradeStatistics([fill('BUY',10,null),fill('SELL',4,'20')]).closed_trades,0);
});
test('v023 paper cannot fill the submission quote, reuse it after restart, or assume a zero-depth bid fills',async()=>{
  const store=new Store(':memory:'),calendar=new TradingCalendar(store,true),market=new ControlledMarket();
  let broker=new PaperBroker(store,market,s,calendar,true);
  try{await broker.connect();await broker.subscribe(['9001'],false);broker.quotes(now);
    await broker.submit(order({created_at:now.toISOString(),limit_price:'31'}));broker.quotes(now);assert.equal(broker.fillCount(),0);
    await broker.close();broker=new PaperBroker(store,market,s,calendar,true);await broker.connect();broker.quotes(now);assert.equal(broker.fillCount(),0);
    market.depth=0;broker.quotes(new Date(now.getTime()+1000));assert.equal(broker.fillCount(),0);
    market.depth=17;broker.quotes(new Date(now.getTime()+2000));assert.equal(broker.fillCount(),1);
    assert.equal((await broker.account(new Date(now.getTime()+2000))).positions[0]!.sellable,0);
  }finally{await broker.close();store.close();}
});
test('v023 daily loss remains latched after recovery and across engine restart, without blocking protection',async()=>{
  const r=await rig();try{r.store.set('daily_loss_breached_2026-10-08',true);await r.engine.tick(new Date(now.getTime()+1000));
    assert.equal(r.store.orders().length,0);assert.match(r.engine.decisionStates.get('9001')!.reason,/日損失/);
    r.store.set('daily_loss_breached_2026-10-08',true);assert.equal(r.store.get('daily_loss_breached_2026-10-08'),true);
  }finally{await r.engine.close();r.store.close();}
});
test('v023 missing-signal reasons distinguish cost, buying power, settlement, data and hard daily loss',()=>{
  for(const [reason,category] of [['預期淨利不足最低成本效益門檻','COST'],['購買力不足','BUYING_POWER'],['交割款尚未入帳','UNSETTLED_CREDIT'],
    ['行情或資料不足','DATA'],['達到日損失限制','DAILY_LOSS']])assert.equal(waitCategory(reason!),category);
});
test('v023 T+2 sale credit remains unavailable until 11:00, including persisted legacy credits',async()=>{
  const store=new Store(':memory:');store.set('paper_ledger',{cash:'100',lots:[],orders:[],lastEvents:{},charges:{},fills:[],credits:[{due:'2026-10-08',amount:'5000'}]});
  const broker=new PaperBroker(store,new ControlledMarket(),s,new TradingCalendar(store,true),true);
  try{const before=await broker.account(new Date('2026-10-08T10:59:59+08:00'));assert.equal(before.cash,'100');assert.equal(before.settlement_credits,'5000');
    const after=await broker.account(new Date('2026-10-08T11:00:00+08:00'));assert.equal(after.cash,'5100');assert.equal(after.settlement_credits,'0');
  }finally{await broker.close();store.close();}
});
test('v023 indexed active-order reads and replay change cursors preserve partial fills and terminal status changes',()=>{
  const store=new Store(':memory:');try{const o=order();assert.equal(store.insertIntent(o),true);const first=store.orderRevision;
    assert.equal(store.changedOrders(0)[0]!.created,true);store.saveOrder({...o,status:'PARTIAL',filled:10});
    assert.equal(store.orders(true)[0]!.filled,10);assert.equal(store.changedOrders(first)[0]!.created,false);
    const second=store.orderRevision;store.saveOrder({...o,status:'FILLED',filled:30});assert.equal(store.orders(true).length,0);
    assert.equal(store.changedOrders(second)[0]!.order.status,'FILLED');assert.equal(store.lastOrder(o.symbol)!.filled,30);
    const revision=store.orderRevision;store.saveOrder({...o,status:'FILLED',filled:30});assert.equal(store.orderRevision,revision);
  }finally{store.close();}
});
test('v023 rolled-back intents never appear in the replay change cursor',()=>{
  const store=new Store(':memory:');try{assert.throws(()=>store.prepareIntent(order(),{symbol:'9001'} as never));
    assert.equal(store.order(order().local_id),undefined);assert.deepEqual(store.changedOrders(0),[]);
  }finally{store.close();}
});
test('v023 offline stale-data elision matches the full GUI event path for fills, costs, equity and drawdown',async()=>{
  const data=syntheticDataset('2026-01-05','2026-01-09'),request={start:'2026-01-05',end:'2026-01-09',source:'sample',strategy:'demo',monitor_interval_seconds:300};
  data.points=data.points.filter(p=>p.at<'2026-01-05'||['01:10','01:20','05:30'].includes(p.at.slice(11,16)));
  const fixtureSettings={...s,min_entry_reward_risk:'0',max_trade_risk_fraction:'0'};
  const full=await runBacktest(request,data,fixtureSettings,undefined,new AbortController().signal,undefined,undefined,()=>undefined);
  const fast=await runBacktest(request,data,fixtureSettings,undefined,new AbortController().signal);
  assert.ok(full.fills.length>0,'The event equivalence fixture must exercise actual synthetic fills');
  assert.ok(full.orders.every(o=>o.trigger_reason&&full.workflow!.some(e=>e.stage==='TRIGGER'&&e.order_id===o.local_id)));
  for(const key of ['final_equity','realized_pnl','unrealized_pnl','fees','taxes','max_drawdown_pct'] as const)assert.equal(fast.metrics[key],full.metrics[key],key);
  const comparable=(r:typeof full)=>r.fills.map(({at,symbol,action,shares,price,fee,tax})=>({at,symbol,action,shares,price,fee,tax}));
  assert.deepEqual(comparable(fast),comparable(full));assert.ok(fast.metrics.skipped_idle_checks!>0);
});
test('v023 consecutive limit-down sessions with no bid depth defer the stop and realize a later loss beyond the nominal stop budget',async()=>{
  const store=new Store(':memory:'),calendar=new TradingCalendar(store,true),market=new ControlledMarket();
  store.set('paper_ledger',{cash:'89980',lots:[{symbol:'9001',shares:100,price:'100',cost:'10020',acquired:'2026-10-08'}],orders:[],lastEvents:{},charges:{},fills:[],credits:[]});
  const price=(at:Date)=>at.toISOString().startsWith('2026-10-12')?'90':at.toISOString().startsWith('2026-10-13')?'81':'82';
  market.quotes=at=>{const last=price(at),liquid=last==='82';return [{...quote(at),last,bid:liquid?'81.9':last,ask:d(last).plus('.1').toFixed(),bid_shares:liquid?100:0,ask_shares:100}];};
  market.instruments=async(symbols,at)=>Object.fromEntries(symbols.map(symbol=>[symbol,{symbol,name:'stress fixture',exchange:'TSE',category:'SYNTHETIC',kind:'STOCK',
    reference:price(at)==='90'?'100':price(at)==='81'?'90':'81',limit_down:price(at)==='90'?'90':price(at)==='81'?'81':'72.9',limit_up:'110',suspended:false,disposition:false,attention:false,verified_at:at.toISOString()}]));
  const broker=new PaperBroker(store,market,s,calendar,true),engine=new Engine(store,broker,s,calendar);
  store.saveProtection(updateProtection(undefined,'9001',{stop_price:'95',take_profit:'125',trailing_activate:null,trailing_fraction:null},'stress'));
  try{await engine.start(new Date('2026-10-12T09:10:00+08:00'));
    for(const day of ['2026-10-12','2026-10-13']){await engine.tick(new Date(day+'T09:11:00+08:00'));assert.equal(store.orders().length,0);assert.match(engine.decisionStates.get('9001')!.reason,/無有效買盤/);}
    await engine.tick(new Date('2026-10-14T09:11:00+08:00'));assert.equal(store.orders().length,1);assert.equal(broker.fillCount(),0);
    await engine.tick(new Date('2026-10-14T09:12:00+08:00'));const fill=broker.fills()[0]!;assert.equal(fill.price,'81.9');assert.ok(d(fill.realized_pnl!).lt('-1500'));
    assert.equal(store.protections().length,0);assert.equal(engine.account!.positions.length,0);assert.ok(d(engine.account!.settlement_credits).gt(0));
  }finally{await engine.close();store.close();}
});
test('v023 official typhoon closure survives annual refresh and postpones T+2 without treating missing prices as a holiday',()=>{
  const store=new Store(':memory:'),calendar=new TradingCalendar(store);try{
    assert.equal(calendar.isOpen('2026-07-10'),false);assert.equal(calendar.next(calendar.next('2026-07-08')),'2026-07-13');
    const days=applyCalendarExceptions([{day:'2026-07-10',open:true,source:'annual fixture',verified_at:now.toISOString()},
      {day:'2026-07-09',open:true,source:'annual fixture',verified_at:now.toISOString()}]);
    assert.equal(days[0]!.open,false);assert.match(days[0]!.source,/twse.*pdf/);assert.equal(days[1]!.open,true);
  }finally{store.close();}
});
test('v023 market closure with settlement operations advances T+2 without authorizing a trade session',()=>{
  const store=new Store(':memory:'),calendar=new TradingCalendar(store);try{
    assert.equal(calendar.isOpen('2026-02-12'),false);assert.equal(calendar.nextSettlement(calendar.nextSettlement('2026-02-11')),'2026-02-13');
    assert.equal(calendar.inSession(new Date('2026-02-12T10:00:00+08:00')),false);
    const rows=Array.from({length:8},(_,i)=>[`2026-02-${String(i+12).padStart(2,'0')}`,i<2?'市場無交易，僅辦理結算交割作業':'農曆春節','fixture']);
    const parsed=parseCalendar({stat:'ok',title:'115 年',fields:['日期','名稱','說明'],data:rows},2026,'https://www.twse.com.tw/fixture');
    assert.equal(parsed.find(d=>d.day==='2026-02-12')!.settlement_open,true);assert.equal(parsed.find(d=>d.day==='2026-02-14')!.settlement_open,false);
  }finally{store.close();}
});
test('v023 historical calendar requests the selected year with the official date parameter, rejecting a wrong-year response',async()=>{
  const store=new Store(':memory:'),calendar=new TradingCalendar(store),data=Array.from({length:8},(_,i)=>[`2025-01-${String(i+1).padStart(2,'0')}`,'休市','fixture']);
  try{let requested='';await calendar.refresh(2025,undefined,async url=>{requested=String(url);return new Response(JSON.stringify({stat:'ok',title:'114 年',fields:['日期','名稱','說明'],data}));});
    assert.equal(new URL(requested).searchParams.get('date'),'20250101');assert.equal(new URL(requested).searchParams.has('queryYear'),false);
    await assert.rejects(()=>calendar.refresh(2025,undefined,async()=>new Response(JSON.stringify({stat:'ok',title:'115 年',fields:['日期','名稱','說明'],data}))),/年份/);
  }finally{store.close();}
});
