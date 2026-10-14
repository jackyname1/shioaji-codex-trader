import {Decimal} from 'decimal.js';
import {d,equity,type Account,type Settings,type SmartSpec} from './models.js';

export const fee=(amount:Decimal.Value,s:Settings):Decimal=>Decimal.max(s.minimum_fee,d(amount).times(s.fee_rate).ceil());
export function rewardTarget(s:SmartSpec|undefined):string|null {
  if(!s)return null;
  return s.take_profit&&s.reward_target?Decimal.min(s.take_profit,s.reward_target).toFixed():s.take_profit??s.reward_target??null;
}
export function roundTripEstimate(shares:number,buyPrice:string,targetPrice:string|null,s:Settings,stopPrice:string|null=null){
  const entry=d(buyPrice).times(shares),buyFee=fee(entry,s),target=targetPrice===null?null:d(targetPrice).times(shares);
  const sellFee=target===null?null:fee(target,s),tax=target===null?null:target.times(s.sell_tax_rate).ceil();
  const costs=sellFee===null?null:buyFee.plus(sellFee).plus(tax!);
  const reward=target===null?null:target.minus(entry).minus(costs!);
  const stop=stopPrice===null?null:d(stopPrice).times(shares);
  const loss=stop===null?null:entry.minus(stop).plus(buyFee).plus(fee(stop,s)).plus(stop.times(s.sell_tax_rate).ceil());
  return {shares,buy_price:buyPrice,target_price:targetPrice,buy_fee:buyFee.toFixed(),
    estimated_sell_fee:sellFee?.toFixed()??null,estimated_sell_tax:tax?.toFixed()??null,
    estimated_total_costs:costs?.toFixed()??null,estimated_net_target_gain:reward?.toFixed()??null,
    stop_price:stopPrice,estimated_stop_loss:loss?.toFixed()??null,
    estimated_reward_risk:reward!==null&&loss?.gt(0)?reward.div(loss).toFixed():null};
}
export function entryRiskIssues(shares:number,price:string,smart:SmartSpec|undefined,a:Account,s:Settings):string[]{
  if(!d(s.max_trade_risk_fraction).gt(0))return [];
  if(!smart||!d(smart.stop_price).lt(price))return ['進場停損資料不足或不合法'];
  const estimate=roundTripEstimate(shares,price,rewardTarget(smart),s,smart.stop_price);
  return d(estimate.estimated_stop_loss!).gt(equity(a).times(s.max_trade_risk_fraction))?['超過單筆停損風險預算（含費稅）']:[];
}
export function entryQualityIssues(shares:number,price:string,smart:SmartSpec|undefined,s:Settings):string[]{
  if(!d(s.min_entry_reward_risk).gt(0))return [];
  const target=rewardTarget(smart);
  if(!smart||!target||!d(smart.stop_price).lt(price)||!d(target).gt(price))return ['缺少有效停損與收益目標，無法核對扣費報酬風險比'];
  const estimate=roundTripEstimate(shares,price,target,s,smart.stop_price);
  if(!d(estimate.estimated_net_target_gain!).gt(0))return ['停利價差不足覆蓋雙邊手續費與賣出稅'];
  return d(estimate.estimated_reward_risk!).lt(s.min_entry_reward_risk)?['扣費後報酬風險比未達進場門檻']:[];
}
