import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SettingsSchema,type Features} from '../src/core/models.js';
import {portfolioDecision,closedEpisodes,marketRegime,type PortfolioState} from '../src/core/portfolio-risk.js';
import {authorizedRisk} from '../src/core/risk-policy.js';
import {Risk} from '../src/core/risk.js';
import {entryRiskIssues} from '../src/core/costs.js';
import {candidateScore} from '../src/core/entry-quality.js';
import {Store} from '../src/core/store.js';
import {TradingCalendar} from '../src/core/calendar.js';
import {account,instrument,quote,order,now,rig} from './helpers.js';
import type {Experience} from '../src/core/experience.js';
const features=():Record<string,Features>=>Object.fromEntries(Array.from({length:8},(_,i)=>[String(9001+i),
  {sufficient:true,sessions:80,asof:'2026-10-07',ma5:100,ma20:98,ma20_previous:97,ma60:95,last_close:100,atr14:3,rsi14:55,volume_ratio20:1.1,resistance20:115,return20:.03}]));
const s=SettingsSchema.parse({portfolio_risk_enabled:true,mode:'paper'});
function decide(previous:PortfolioState|undefined,cash:string,at=now){return portfolioDecision(previous,{...account(),cash,asof:at.toISOString()},features(),[],s,at,true);}
test('authorized ceilings apply to fresh, saved and replay profiles, while stricter limits survive',()=>{
 const wide=SettingsSchema.parse({min_cash_fraction:'0.20',max_order_fraction:'0.20',order_budget_basis:'EQUITY',max_symbol_fraction:'0.25',max_exposure_fraction:'0.80',max_daily_buy_fraction:'0.60',max_daily_buy_orders:8,daily_loss_fraction:'0.05'});
 const safe=authorizedRisk(wide);assert.equal(safe.min_cash_fraction,'0.25');assert.equal(safe.order_budget_basis,'AFTER_RESERVE');
 assert.equal(safe.max_order_fraction,'0.10');assert.equal(safe.max_symbol_fraction,'0.20');assert.equal(safe.max_exposure_fraction,'0.75');
 assert.equal(safe.max_daily_buy_fraction,'0.20');assert.equal(safe.max_daily_buy_orders,5);assert.equal(safe.daily_loss_fraction,'0.02');
 const strict=authorizedRisk(SettingsSchema.parse({min_cash_fraction:'0.4',max_exposure_fraction:'0.6',max_order_fraction:'0.04'}));assert.equal(strict.max_order_fraction,'0.04');
 const store=new Store(':memory:');try{store.set('settings',wide);assert.deepEqual(store.settings(),safe);}finally{store.close();}
 assert.throws(()=>SettingsSchema.parse({mode:'live',portfolio_risk_enabled:true}),/僅供/);
 assert.throws(()=>SettingsSchema.parse({mode:'live',research_exit_mode:'atr_trail'}),/僅供/);
});
test('HWM is measured with the gate off and survives restart; invalid and old account data cannot lower or raise it',async()=>{
 const r=await rig();try{
  const state=r.engine.portfolioRisk(now)!.state;assert.equal(state.high_water,'100000');
  const future=new Date(now.getTime()+1000),stale={...account(),cash:'200000',asof:new Date(now.getTime()-61000).toISOString()};
  const p=portfolioDecision(state,stale,features(),[],s,future,true);assert.equal(p.state.high_water,'100000');assert.equal(p.blocked,true);
  assert.equal(portfolioDecision(state,{...account(),cash:'200000'},features(),[],s,new Date(now.getTime()-1000),true).state.high_water,'100000');
  assert.equal(r.store.get<PortfolioState>('portfolio_risk_v1')!.high_water,'100000');
 }finally{await r.engine.close();r.store.close();}
});
test('3/4/5 percent gates latch only at their own threshold and require observed sessions plus recovery',()=>{
 for(const threshold of ['0.03','0.04','0.05']){
  const cfg={...s,portfolio_drawdown_fraction:threshold},first=decide(undefined,'100000');
  const at=new Date('2026-10-08T11:00:00+08:00');
  const p=portfolioDecision(first.state,{...account(),cash:String(100000*(1-Number(threshold))),asof:at.toISOString()},features(),[],cfg,at,true);
  assert.equal(p.blocked,true);assert.equal(p.state.drawdown_latched,true);
  const rebound=portfolioDecision(p.state,{...account(),cash:'100000',asof:at.toISOString()},features(),[],cfg,at,true);assert.equal(rebound.blocked,true);
  const one=new Date('2026-10-12T10:00:00+08:00'),two=new Date('2026-10-13T10:00:00+08:00');
  const a=portfolioDecision(rebound.state,{...account(),asof:one.toISOString()},features(),[],cfg,one,true);
  const b=portfolioDecision(a.state,{...account(),asof:two.toISOString()},Object.fromEntries(Object.entries(features()).map(([k,f])=>[k,{...f,asof:'2026-10-12'}])),[],cfg,two,true);
  assert.equal(b.state.drawdown_latched,false);assert.equal(b.blocked,false);assert.equal(b.state.high_water,'100000');
 }
});
test('market proxy uses only prior completed data, with explicit UNKNOWN and high-volatility states',()=>{
 assert.equal(marketRegime(features(),now).regime,'TREND');
 assert.equal(marketRegime(Object.fromEntries(Object.entries(features()).map(([k,f])=>[k,{...f,asof:'2026-10-08'}])),now).regime,'UNKNOWN');
 assert.equal(marketRegime(Object.fromEntries(Object.entries(features()).map(([k,f])=>[k,{...f,atr14:8}])),now).regime,'HIGH_RISK');
 const p=portfolioDecision(undefined,account(),{},[],s,now,true);assert.equal(p.blocked,true);assert.match(p.reasons.join(),/資料不足/);
});
function event(id:string,action:'BUY'|'SELL',shares:number,pnl:string|null,symbol='9001'):Experience{return {id,at:now.toISOString(),mode:'paper',kind:'SIMULATED_FILL',symbol,action,shares,price:'100',fee:'20',tax:'0',realized_pnl:pnl,note:''};}
test('disabled portfolio gate still observes scoped full episodes independent of prompt feedback and as-of limits',async()=>{
 const r=await rig();try{
  r.engine.setSettings({...r.engine.settings,portfolio_risk_enabled:false,experience_enabled:false,experience_limit:5});
  r.store.set('experience_scope','isolated-replay');
  const at=new Date(now.getTime()+2000);
  for(const e of [event('buy','BUY',10,null),event('partial','SELL',5,'-10'),event('closed','SELL',5,'-20')])r.store.recordExperience({...e,mode:'isolated-replay'});
  for(let i=0;i<8;i++)r.store.recordExperience({...event('noise'+i,'BUY',0,null),kind:'RISK_REFUSAL',action:'NONE',mode:'isolated-replay'});
  r.store.recordExperience({...event('foreign','SELL',10,'-999'),mode:'another-replay'});
  r.store.recordExperience({...event('later','BUY',10,null),mode:'isolated-replay',at:new Date(at.getTime()+1000).toISOString()});
  const p=r.engine.portfolioRisk(at,{...account(),asof:at.toISOString()})!;
  assert.equal(p.closed_trades,1);assert.equal(p.recent_expectancy,'-30');assert.equal(p.enabled,false);
  assert.equal(p.scale,'1');assert.equal(p.blocked,false);assert.deepEqual(p.reasons,[]);
  assert.equal(r.store.simulatedFills('isolated-replay',at.toISOString()).length,3);
 }finally{await r.engine.close();r.store.close();}
});
test('partial exits and unclosed positions do not inflate consecutive losses; recent negative expectancy scales entries',()=>{
 const es=[event('a','BUY',10,null),event('b','SELL',5,'-10'),event('c','SELL',5,'-20')];
 assert.equal(closedEpisodes(es,now.toISOString()).length,1);assert.equal(closedEpisodes(es,now.toISOString())[0]!.pnl,'-30');
 for(let i=0;i<2;i++)es.push(event('d'+i,'BUY',1,null),event('e'+i,'SELL',1,'-20'));
 const p=portfolioDecision(undefined,account(),features(),es,s,now,true);assert.equal(p.state.loss_latched,true);assert.equal(p.blocked,true);
 assert.equal(closedEpisodes([event('missing','SELL',1,'-100')],now.toISOString()).length,0);
 const partial=portfolioDecision(undefined,account(),features(),es.slice(0,3),s,now,true);assert.equal(partial.blocked,false);
});
test('new entry risk includes all existing symbol costs, and uses realistic gap/liquidation cost',()=>{
 const cfg=SettingsSchema.parse({max_trade_risk_fraction:'0.0125'}),smart={stop_price:'95',take_profit:'115',trailing_activate:null,trailing_fraction:null};
 const a=account();a.positions=[{symbol:'9001',shares:100,sellable:100,average_price:'110',last_price:'100',cost_basis:'11020'}];
 assert.deepEqual(entryRiskIssues(10,'100',smart,a,cfg),[]);
 assert.match(entryRiskIssues(10,'100',smart,a,cfg,'9001').join(),/合併持倉/);
});
test('daily counters cannot understate pending, partial and filled commitments or double count reserved amounts',()=>{
 const store=new Store(':memory:');try{
 const cfg=SettingsSchema.parse({max_daily_buy_orders:2}),risk=new Risk(cfg,new TradingCalendar(store,true)),a=account();
 a.orders=[order({symbol:'9002',local_id:'a',shares:100,limit_price:'100',status:'PENDING'}),order({symbol:'9003',local_id:'b',shares:100,filled:50,limit_price:'100',status:'PARTIAL'})];
 const reasons=risk.check(order(),a,quote(),instrument(),now,'100000');assert.match(reasons.join(),/單日新增買進金額/);assert.match(reasons.join(),/筆數/);
 a.orders=[a.orders[0]!];a.daily_buy_amount='10000';a.daily_buy_count=1;
 assert.ok(!risk.check(order(),a,quote(),instrument(),now,'100000').some(r=>/單日/.test(r)));
 }finally{store.close();}
});
test('explainable score flags chasing, nearby resistance, tiny ATR stop and stale quotes without symbol rules',()=>{
 const f=features()['9001']!,q={...quote(),last:'100',ask:'100',bid:'99.9'};
 const good=candidateScore(f,q,s,now,'TREND',50,{stop_price:'95',take_profit:'115',trailing_activate:null,trailing_fraction:null});
 assert.ok(good.score>=50);assert.deepEqual(good.reasons,[]);
 assert.match(candidateScore({...f,resistance20:101},q,s,now,'TREND').reasons.join(),/壓力/);
 assert.match(candidateScore(f,{...q,ask:'130'},s,now,'TREND').reasons.join(),/追價/);
 assert.match(candidateScore(f,q,s,now,'TREND',50,{stop_price:'99',take_profit:'115',trailing_activate:null,trailing_fraction:null}).reasons.join(),/ATR/);
});

test('drawdown, regime and loss mechanisms can be isolated without attributing bundled effects to one guard',()=>{
 const highVol=Object.fromEntries(Object.entries(features()).map(([k,f])=>[k,{...f,atr14:8}]));
 const base=decide(undefined,'100000').state,a={...account(),cash:'95000'};
 const dd=portfolioDecision(base,a,highVol,[],{...s,portfolio_components:'drawdown'},now,true);assert.equal(dd.blocked,true);assert.match(dd.reasons.join(),/組合高點回撤/);
 const regime=portfolioDecision(base,a,highVol,[],{...s,portfolio_components:'regime'},now,true);assert.equal(regime.blocked,false);assert.equal(regime.scale,'0.25');
 const loss=portfolioDecision(base,a,highVol,[],{...s,portfolio_components:'loss_streak'},now,true);assert.equal(loss.blocked,false);assert.equal(loss.scale,'1');
});

test('an oversized different holding blocks new risk without preventing a lawful protective exit',()=>{
 const store=new Store(':memory:');try{
  const cfg=SettingsSchema.parse({}),risk=new Risk(cfg,new TradingCalendar(store,true)),a=account();a.cash='77000';
  a.positions=[{symbol:'9002',shares:230,sellable:230,average_price:'90',last_price:'100'}];
  assert.match(risk.check(order(),a,quote(),instrument(),now,'100000').join(),/既有 9002.*停止新增風險/);
  assert.deepEqual(risk.check(order({symbol:'9002',action:'SELL',purpose:'PROTECTION',shares:10,limit_price:'100'}),a,
   {...quote(),symbol:'9002',last:'100',bid:'100',ask:'100.5'},{...instrument(),symbol:'9002',reference:'100',limit_down:'90',limit_up:'110'},now,'100000'),[]);
 }finally{store.close();}
});
