import {active,addDays,d,equity,remaining,twDay,type Account,type Decision,type Features,type Instrument,type Order,type Quote,type Settings,type SmartSpec} from './models.js';
import type {TradingCalendar} from './calendar.js';
import {fee} from './costs.js';

/** Completed-session observations only. These are hypotheses, not an estimated probability of profit. */
export function confirmationIssues(policy:Settings['entry_policy'],f:Features|undefined,q:Quote|undefined,decision?:Decision):string[]{
  if(policy==='legacy')return [];
  if(!f?.sufficient||!q||![f.ma5,f.ma20,f.ma60,f.ma20_previous,f.atr14,f.volume_ratio20].every(x=>typeof x==='number'&&Number.isFinite(x)&&x>0))return ['確認策略缺少完整趨勢、波動度或量能資料'];
  const issues:string[]=[];
  if(!(f.ma5!>=f.ma20!&&f.ma20!>=f.ma60!&&f.ma20!>f.ma20_previous!))issues.push('確認策略需要 MA5 ≥ MA20 ≥ MA60 且 MA20 上升');
  if(d(q.last).lt(f.ma5!))issues.push('尚未重新站上 MA5，禁止立即抄底');
  if(d(q.last).minus(f.ma20!).gt(d(f.atr14!).times(2)))issues.push('價格距離 MA20 超過 2 ATR，避免追高');
  if(policy==='pullback'&&decision?.entry_when!=='REBOUND')issues.push('回檔策略需先觀察低點再觸發 REBOUND，不能立即進場');
  if(policy==='breakout'&&(!f.previous_resistance20||!d(q.last).gt(f.previous_resistance20)||f.volume_ratio20!<1.2))issues.push('突破策略需超越此前壓力且前一完整交易日量比 ≥ 1.2；不代表盤中量能確認');
  return issues;
}
export function breadthState(features:Record<string,Features>):'RISK_OFF'|'NORMAL'|'UNKNOWN'{
  const rows=Object.values(features).filter(f=>f.sufficient&&f.ma20&&f.ma60&&f.last_close);
  if(rows.length<5)return 'UNKNOWN';
  return rows.filter(f=>f.last_close!>=f.ma20!&&f.ma20!>=f.ma60!).length/rows.length<.4?'RISK_OFF':'NORMAL';
}
/** Final deterministic admission check. Missing sector/protection data cannot silently count as zero risk. */
export function admissionIssues(order:Order,a:Account,s:Settings,spec:SmartSpec|undefined,metadata:Record<string,Instrument>,
  features:Record<string,Features>,q:Quote|undefined,decision:Decision|undefined,calendar:TradingCalendar,now:Date,lastSell?:string,
  stops:Record<string,string>={}):string[]{
  if(order.action!=='BUY')return [];
  const instrument=metadata[order.symbol],issues:string[]=[];
  if(spec&&instrument&&d(spec.stop_price).lte(instrument.limit_down))issues.push('停損不得位於或低於跌停價，不能視為可成交的保護');
  if(s.entry_policy==='legacy')return issues;
  issues.push(...confirmationIssues(s.entry_policy,features[order.symbol],q,decision));
  if(breadthState(features)!=='NORMAL')issues.push('股票池廣度風險偏高或不足五檔有效資料；此值不是大盤指數');
  if(a.positions.some(p=>p.symbol===order.symbol&&p.shares>0))issues.push('確認策略禁止同股加碼，先完成既有交易');
  if(lastSell){let completed=0;for(let day=addDays(twDay(new Date(lastSell)),1);day<twDay(now)&&completed<2;day=addDays(day,1))if(calendar.isOpen(day))completed++;
    if(completed<2)issues.push('賣出後尚未完成兩個交易日冷卻');}
  if(!spec||!instrument||d(spec.stop_price).lte(instrument.limit_down))issues.push('停損不得位於或低於跌停價，不能視為可成交的保護');
  const category=instrument?.category;
  const known=(v:string|undefined)=>!!v&&!['HISTORICAL_SIMULATION','DEMO','UNKNOWN'].includes(v);
  const buys=a.orders.filter(o=>active(o)&&o.action==='BUY'&&o.local_id!==order.local_id);
  let sector=d(order.limit_price).times(order.shares),risk=d(0);
  for(const p of a.positions){
    // Unknown categories are fully correlated with every sector, never assumed diversified.
    if(!known(category)||!known(metadata[p.symbol]?.category)||metadata[p.symbol]?.category===category)sector=sector.plus(d(p.last_price).times(p.shares));
    const stop=stops[p.symbol];if(!stop){issues.push('既有持倉缺少保護，無法驗證組合停損');continue;}
    const proceeds=d(stop).times(d(1).minus(s.risk_slippage_fraction)).times(p.shares);
    risk=risk.plus(d(p.last_price).times(p.shares).minus(proceeds).plus(fee(proceeds,s)).plus(proceeds.times(s.sell_tax_rate).ceil()).clamp(0,Infinity));
  }
  // Pending buys without an independently stored stop reserve their full notional as worst-case loss.
  for(const o of buys){const amount=d(o.limit_price).times(remaining(o));risk=risk.plus(amount).plus(fee(amount,s));
    if(!known(category)||!known(metadata[o.symbol]?.category)||metadata[o.symbol]?.category===category)sector=sector.plus(amount);}
  if(sector.gt(equity(a).times('.30')))issues.push('超過同產業 30% 曝險上限（含掛單）');
  if(spec){const amount=d(order.limit_price).times(order.shares),proceeds=d(spec.stop_price).times(d(1).minus(s.risk_slippage_fraction)).times(order.shares);
    risk=risk.plus(amount.minus(proceeds).plus(fee(amount,s)).plus(fee(proceeds,s)).plus(proceeds.times(s.sell_tax_rate).ceil()));}
  if(risk.gt(equity(a).times('.02')))issues.push('同時觸停損的組合估計損失超過 2%；跳空仍可能超額');
  return [...new Set(issues)];
}
