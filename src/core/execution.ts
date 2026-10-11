import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { active, d, equity, remaining, type Account, type Decision, type Features, type Instrument,
  type Order, type Quote, type Settings, type SmartSpec } from './models.js';
import { Risk, fee, roundPrice } from './risk.js';

export const ExecutionAdviceSchema=z.strictObject({
  request_id:z.string().min(1),symbol:z.string().regex(/^[0-9A-Z]{4,8}$/),
  action:z.enum(['BUY','SELL','HOLD']),shares:z.number().int().min(0).max(999000),
  lot:z.enum(['ODD','COMMON']),limit_price:z.string().regex(/^\d+(?:\.\d+)?$/),
  reason:z.string().min(1).max(3000),
}).refine(x=>x.action==='HOLD'?x.shares===0:x.shares>0&&d(x.limit_price).gt(0),'交易需有有效股數及限價；觀望股數為零');
export type ExecutionAdvice=z.infer<typeof ExecutionAdviceSchema>;
export interface ExecutionTicket {
  id:string;key:string;queued_at:string;state:'QUEUED'|'RUNNING';order:Order;
  source:'CODEX'|'RULE'|'PROTECTION';trigger:string;condition?:Decision;smart?:SmartSpec;
  protection_spec?:SmartSpec;allocation_fraction?:string;settings_key:string;generation:number;
}
export interface ExecutionLot {
  lot:'ODD'|'COMMON';quote:Quote;limit_price:string;min_price:string;max_price:string;
  step:number;max_shares:number;reasons:string[];
}
export interface ExecutionRequest {
  request_id:string;asof:string;triggered_at:string;symbol:string;action:'BUY'|'SELL';purpose:Order['purpose'];
  source:ExecutionTicket['source'];trigger:string;plan_id:string;condition?:Decision;protection?:SmartSpec;
  account:{cash:string;settlement_debits:string;settlement_credits:string;reserved_buys:string;
    available_cash:string;equity:string;positions:Account['positions'];
    open_orders:{symbol:string;action:string;shares:number;limit_price:string}[];daily_buy_count:number;daily_buy_amount:string};
  lots:ExecutionLot[];features?:Features;instrument:Instrument;hard_limits:Record<string,unknown>;
  historical_replay:boolean;
}
export const executionSettingsKey=(s:Settings):string=>JSON.stringify(Object.entries(s)
  .filter(([key])=>!['start_minimized','keep_awake'].includes(key)).sort(([a],[b])=>a.localeCompare(b)));
export function spendableCash(account:Account,s:Settings):{reserved:string;available:string}{
  const reserved=account.orders.filter(o=>active(o)&&o.action==='BUY').reduce((sum,o)=>{
    const amount=d(o.limit_price).times(remaining(o));return sum.plus(amount).plus(fee(amount,s));
  },d(0));
  return {reserved:reserved.toFixed(),available:Decimal.max(0,d(account.cash).minus(account.settlement_debits).minus(reserved)).toFixed()};
}
/** Bounds are determined by the same final risk checker, including fees and all standing reservations. */
export function executionLot(ticket:ExecutionTicket,q:Quote,account:Account,instrument:Instrument,risk:Risk,
  now:Date,baseline:string|undefined,lastTrade:string|undefined):ExecutionLot {
  const s=risk.settings,lot=q.odd?'ODD':'COMMON',step=q.odd?1:1000;
  let min=Decimal.max(instrument.limit_down,d(q.last).times(d(1).minus(s.price_deviation_fraction)));
  let max=Decimal.min(instrument.limit_up,d(q.last).times(d(1).plus(s.price_deviation_fraction)));
  // Explicit plan limits remain buy ceilings / sell floors. Rule/protection orders follow the fresh book.
  if(ticket.source==='CODEX'){
    if(ticket.order.action==='BUY')max=Decimal.min(max,ticket.order.limit_price);
    else min=Decimal.max(min,ticket.order.limit_price);
  }
  if(ticket.order.action==='BUY'&&ticket.smart){
    min=Decimal.max(min,ticket.smart.stop_price);
    if(ticket.smart.take_profit)max=Decimal.min(max,ticket.smart.take_profit);
  }
  const minPrice=roundPrice(min,false),maxPrice=roundPrice(max);
  const price=roundPrice(ticket.order.action==='BUY'?Decimal.min(q.ask,maxPrice):Decimal.max(q.bid,minPrice),ticket.order.action!=='BUY');
  const test=(shares:number):string[]=>{
    const reasons=risk.check({...ticket.order,lot,shares,limit_price:price},account,q,instrument,now,baseline,false,lastTrade);
    if(ticket.allocation_fraction&&d(price).times(shares).plus(fee(d(price).times(shares),s)).gt(equity(account).times(ticket.allocation_fraction)))
      reasons.push('超過 Codex 本輪配置上限');
    return reasons;
  };
  const reasons=test(step);
  if(d(minPrice).gt(maxPrice)||d(price).lt(minPrice)||d(price).gt(maxPrice))reasons.push('策略限價與目前可用價格範圍不符');
  if(ticket.order.action==='BUY'&&ticket.smart&&(d(price).lte(ticket.smart.stop_price)
    ||ticket.smart.take_profit&&d(price).gte(ticket.smart.take_profit)))reasons.push('目前進場價已超過保護條件範圍');
  let units=0;
  if(!reasons.length){
    let lo=1,hi=q.odd?999:999;
    while(lo<=hi){const mid=Math.floor((lo+hi)/2);if(!test(mid*step).length){units=mid;lo=mid+1;}else hi=mid-1;}
  }
  return {lot,quote:structuredClone(q),limit_price:price,min_price:minPrice,max_price:maxPrice,step,max_shares:units*step,reasons};
}
export function executionPrompt(request:ExecutionRequest):string {
  return `你是台灣現股交易數量確認器。本次已由程式確認 Codex 先前設定的條件觸發。
只能根據這份當前快照決定交易股數及限價，不得使用任何工具、查詢外部資料、改變策略、股票或買賣方向。
request_id、symbol 必須完全相符。action 只能沿用指定 BUY / SELL，或 HOLD 放棄本次行動。
shares 一律是股數，不是張數；一張=1000股。ODD 是 1–999 股；COMMON 只能使用 1000 股倍數且必須有可用 COMMON 範圍。
股數不得超過所選 lots.max_shares；限價必須在 min_price / max_price 內並符合台股跳動單位。
max_shares 是硬性風控上限，不是要求用滿；根據目前現金、保留現金、交割款、掛單占用、持倉集中度與風險決定較合適數量。
SELL 只能使用目前 sellable 的可賣庫存；今日新增零股不得當沖，不能借券、融資或賣空。
SELL 的觸發可能是停損、停利、移動停損或定時策略減碼；清楚說明本次數量理由。
禁止現金不足時改用槓桿、要求降低風控或把尚未可用的賣出交割款當現金。
HOLD 時 shares=0。無法確認或資料不足時必須 HOLD；不要為維持活動而交易。
歷史回放時 asof 是唯一現在，不得使用其後資料或已知未來績效。
只回傳指定 JSON 結構，reason 說明交易理由、數量依據與風險。
以下是唯一可用資料：\n${JSON.stringify(request)}`;
}
