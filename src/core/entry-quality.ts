import {d,twDay,ageSeconds,type Features,type Quote,type Settings,type SmartSpec} from './models.js';
import {roundTripEstimate,rewardTarget} from './costs.js';
import type {Regime} from './portfolio-risk.js';
/** Explanatory scores are hypotheses, never calibrated probabilities or permission to bypass Risk. */
export function candidateScore(f:Features|undefined,q:Quote|undefined,s:Settings,now:Date,regime:Regime='UNKNOWN',
  shares=1,smart?:SmartSpec){
  const reasons:string[]=[],components:Record<string,number>={trend:0,momentum:0,volume:0,volatility:0,location:0,cost:0,regime:0};
  if(!f?.sufficient||!f.asof||f.asof>=twDay(now)||Date.parse(twDay(now))-Date.parse(f.asof)>7*86400000
    ||[f.ma5,f.ma20,f.ma60,f.atr14,f.last_close,f.resistance20].some(v=>v===undefined||!Number.isFinite(v)||v<=0)
    ||f.rsi14===undefined||f.volume_ratio20===undefined)return {score:0,components,reasons:['已完成趨勢／波動資料不足'],net_reward_risk:null};
  const price=q?Number(q.ask):f.last_close!,atr=f.atr14!,distance=(price-f.ma20!)/f.ma20!;
  components.trend=(f.ma5!>=f.ma20!?10:0)+(f.ma20!>=f.ma60!?10:0)+(f.ma20_previous!==undefined&&f.ma20!>=f.ma20_previous?5:0);
  components.momentum=f.rsi14>=40&&f.rsi14<=65?15:f.rsi14<=72&&f.rsi14>=30?7:0;
  components.volume=f.volume_ratio20>=.9&&f.volume_ratio20<=2.5?10:f.volume_ratio20>=.6?5:0;
  components.volatility=atr/price<=.04?10:atr/price<=.065?5:0;
  components.location=distance>=0&&distance<=.04?10:0;
  components.regime=regime==='TREND'?10:regime==='RANGE'?5:0;
  if(distance>.10||price-f.ma20!>3*atr)reasons.push('追價乖離超過 10% 或三倍 ATR');
  if(price<f.ma20!&&f.ma20_previous!==undefined&&f.ma20!<f.ma20_previous)reasons.push('月線下彎且價格失守');
  if(price<=f.resistance20!&&(f.resistance20!-price)<.5*atr)reasons.push('既有壓力前不足半倍 ATR 空間');
  if(q&&[q.trade_at,q.book_at].some(at=>ageSeconds(now,at)<0||ageSeconds(now,at)>s.quote_max_age))reasons.push('進場行情過期');
  const spread=q?d(q.ask).minus(q.bid).div(q.ask):null;
  if(spread?.gt(s.max_spread_fraction))reasons.push('可執行價差過大');
  const estimate=smart?roundTripEstimate(shares,String(price),rewardTarget(smart),s,smart.stop_price):null;
  if(smart&&price-Number(smart.stop_price)<.8*atr)reasons.push('停損落於 0.8 ATR 正常波動範圍內');
  const rr=estimate?.estimated_reward_risk??null;
  components.cost=rr&&d(rr).gte('1.2')?20:rr&&d(rr).gte(1)?10:0;
  return {score:Object.values(components).reduce((a,b)=>a+b,0),components,reasons,net_reward_risk:rr};
}
