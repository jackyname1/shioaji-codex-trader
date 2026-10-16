import {Decimal} from 'decimal.js';
import {active,d,equity,marketValue,remaining,type Account,type Decision,type EntryTrack,type Features,type Plan,type Quote,type Settings} from './models.js';
import {roundPrice} from './risk.js';
import {orderBudget} from './capital.js';
import {entryQualityIssues,entryRiskIssues,fee,roundTripEstimate} from './costs.js';
import {entryReady,trackEntry} from './smart.js';

export interface Opportunity {decision?:Decision;track?:EntryTrack;reason:string;score?:number;signal?:string}
/** Three independent, bounded signals share a single symbol/order identity. No target is derived from a desired RR. */
export function multiOpportunity(plan:Plan,symbol:string,f:Features,q:Quote,a:Account,s:Settings,now:Date,existing?:EntryTrack):Opportunity {
  const rule=plan.analysis.screening!.entry!;
  if(!f.ma5||!f.ma20||!f.ma60||!f.atr14||!f.support20||!f.resistance20||f.rsi14===undefined||f.volume_ratio20===undefined)
    return {reason:'行情或資料不足：三策略需 MA60、ATR、量能與支撐壓力'};
  const price=d(q.last),entry=d(roundPrice(q.ask,false)),atr=d(f.atr14),resistance=d(f.resistance20);
  const up=f.ma5>=f.ma20&&f.ma20>=f.ma60&&(f.ma20_previous===undefined||f.ma20>=f.ma20_previous);
  if(!up)return {reason:'無有效候選：均線趨勢未維持多頭'};
  if(f.rsi14>75||price.gt(d(f.ma20).plus(atr.times(3)))||price.minus(f.ma20).abs().div(f.ma20).gt(rule.max_ma20_distance))
    return {reason:'買入觸發未達：價格過熱或偏離均線'};
  const reboundFraction=Decimal.max('.004',Decimal.min('.025',atr.times('.30').div(f.ma20))).toFixed(6);
  const pullback:Decision={symbol,action:'BUY',shares:1,limit_price:entry.toFixed(),entry_when:'REBOUND',
    trigger_price:d(f.ma20).plus(atr.times('.5')).toFixed(),rebound_fraction:reboundFraction,
    smart:{stop_price:roundPrice(Decimal.max(f.support20,d(f.ma20).minus(atr.times('1.5')))),
      take_profit:resistance.toFixed(),reward_target:resistance.toFixed(),trailing_activate:null,trailing_fraction:null},
    conditions:[],reason:'回檔至 MA20 支撐帶，追蹤階段低點後確認實際回升'};
  const track=trackEntry(existing,pullback,plan.id,q,plan.created_at,s.entry_tracking_minutes);
  let signal='',strength=0,target=resistance,stop=d(pullback.smart!.stop_price);
  const recentBreakout=f.breakout_base20!==undefined&&f.breakout_range20!==undefined&&f.last_close!==undefined
    &&f.last_close>=f.breakout_base20&&price.gte(f.breakout_base20)&&f.volume_ratio20>=.9;
  // A completed recent breakout can continue near new highs. Its old range gives a fixed measured-move objective.
  if(recentBreakout)target=d(f.breakout_base20!).plus(f.breakout_range20!);
  // Priority: confirmed breakout, confirmed rebound, then continued trend. Only one proposal survives.
  if(price.gt(resistance)&&price.lte(resistance.plus(atr.times('.75')))&&entry.lte(resistance.plus(atr))&&f.volume_ratio20>=1.2&&f.rsi14<=72){
    signal='BREAKOUT20';strength=.9;
    target=resistance.plus(resistance.minus(f.support20)); // Completed 20-day range projection, independent of the entry price.
    stop=Decimal.min(resistance.minus(atr.times('.75')),entry.minus(atr.times('1.5')));
  }else if(track.armed&&entryReady(pullback,q.last,track)&&f.volume_ratio20>=.7&&f.rsi14>=35){
    signal='PULLBACK20';strength=.8;stop=Decimal.min(d(track.low_water).minus(atr.times('.75')),stop);
  }else if(price.gte(f.ma5)&&price.gte(f.ma20)&&f.volume_ratio20>=.9&&f.rsi14>=45&&f.rsi14<=75&&(f.return20??-1)>=0){
    signal='TREND';strength=.7;
    stop=Decimal.min(d(f.ma5).minus(atr.times('.5')),entry.minus(atr.times('1.5')));
  }else return {track,reason:track.status==='EXPIRED'?'買入觸發未達：回檔追蹤超時，等待新策略':track.status==='INVALID'?'買入觸發未達：支撐失效，等待新策略':
    track.armed?`追蹤低點 ${track.low_water}；等待回升 ${reboundFraction}`:'買入觸發未達：等待回檔反彈、趨勢延續或突破確認'};
  stop=d(roundPrice(stop));target=d(roundPrice(target));
  if(stop.lte(0)||stop.gte(entry)||entry.minus(stop).div(entry).gt('.15')||target.lte(entry))return {track,reason:'風險報酬不足：支撐、實際賣價與既有壓力不相容'};
  const smart={stop_price:stop.toFixed(),take_profit:target.toFixed(),reward_target:target.toFixed(),
    trailing_activate:s.adaptive_protection?entry.plus(entry.minus(stop).times('1.25')).toFixed():null,
    trailing_fraction:s.adaptive_protection?Decimal.max('.02',Decimal.min('.08',atr.times('1.8').div(entry))).toFixed():null};
  const buys=a.orders.filter(o=>active(o)&&o.action==='BUY'),e=equity(a);
  const reserved=buys.reduce((v,o)=>v.plus(d(o.limit_price).times(remaining(o))).plus(fee(d(o.limit_price).times(remaining(o)),s)),d(0));
  const principal=buys.reduce((v,o)=>v.plus(d(o.limit_price).times(remaining(o))),d(0));
  const held=a.positions.find(p=>p.symbol===symbol),heldValue=held?d(held.last_price).times(held.shares):d(0);
  const symbolReserved=buys.filter(o=>o.symbol===symbol).reduce((v,o)=>v.plus(d(o.limit_price).times(remaining(o))),d(0));
  if(buys.some(o=>o.symbol===symbol))return {track,reason:'訂單去重：同標的已有未完成買單'};
  if(heldValue.plus(symbolReserved).gte(e.times(s.max_symbol_fraction)))return {track,reason:'單檔上限：目前持倉已達集中度限制'};
  const cash=d(a.cash).minus(a.settlement_debits).minus(reserved).minus(e.times(s.min_cash_fraction));
  if(cash.lte(s.minimum_fee))return {track,reason:d(a.settlement_credits).gt(0)?'交割款尚未入帳：待收款不可立即動用':'購買力不足：已扣交割、掛單及現金保留'};
  const gap=Decimal.max(0,e.times(s.target_exposure_fraction).minus(marketValue(a)).minus(principal));
  const weight=s.dynamic_allocation?d('.65').plus(d(strength).times('.35')):d(1);
  const budget=Decimal.min(orderBudget(e,s),e.times(rule.allocation_fraction).times(weight),s.dynamic_allocation?gap:Infinity,
    cash.minus(s.minimum_fee),e.times(s.max_symbol_fraction).minus(heldValue).minus(symbolReserved),e.times(s.max_exposure_fraction).minus(marketValue(a)).minus(principal),
    e.times(s.max_daily_buy_fraction).minus(a.daily_buy_amount));
  const step=q.odd?1:1000;let max=Math.min(q.odd?999:999000,Math.max(0,Math.floor(budget.div(entry).toNumber()/step)*step));
  // Loss is monotone in quantity; binary search finds the largest risk-valid size, then check minimum economics.
  let lo=0,hi=Math.floor(max/step);
  while(lo<hi){const mid=Math.ceil((lo+hi)/2),n=mid*step;
    if(entryRiskIssues(n,entry.toFixed(),smart,a,s).length||entry.times(n).plus(fee(entry.times(n),s)).gt(cash))hi=mid-1;else lo=mid;}
  max=lo*step;
  if(!max)return {track,reason:'購買力或單筆風險上限不足一個交易單位'};
  const quality=entryQualityIssues(max,entry.toFixed(),smart,s);
  if(quality.length)return {track,reason:quality.join('；')};
  const estimate=roundTripEstimate(max,entry.toFixed(),target.toFixed(),s,stop.toFixed());
  const score=strength*Number(estimate.estimated_reward_risk??0)*Math.log1p(Number(estimate.estimated_net_target_gain??0))*(heldValue.gt(0)?.7:1);
  return {track,signal,score,reason:'訊號已觸發，等待最終股數風控核對',decision:{...pullback,entry_when:signal==='PULLBACK20'?'REBOUND':'IMMEDIATE',
    trigger_price:signal==='PULLBACK20'?pullback.trigger_price:'0',rebound_fraction:signal==='PULLBACK20'?reboundFraction:null,
    shares:max,smart,reason:`${signal}；${recentBreakout?'此前已完成突破區間投射':'既有壓力／完成區間'}目標 ${target}；預期淨利 ${estimate.estimated_net_target_gain}；淨報酬風險 ${estimate.estimated_reward_risk}`}};
}
