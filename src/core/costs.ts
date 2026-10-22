import {Decimal} from 'decimal.js';
import {d,equity,remaining,type Account,type Order,type Settings,type SmartSpec} from './models.js';

export const fee=(amount:Decimal.Value,s:Settings):Decimal=>Decimal.max(s.minimum_fee,d(amount).times(s.fee_rate).ceil());
/** Upper bound on the remaining cash obligation of a limit buy. Once any part fills,
 * at least the minimum fee has already been charged. Actual past prices may be better
 * than the limit, so only that known lower bound is deducted, never an invented fee.
 */
export function remainingBuyCost(order:Order,s:Settings):Decimal {
  const amount=d(order.limit_price).times(remaining(order));
  if(amount.lte(0))return d(0);
  const extra=order.filled>0?Decimal.max(0,fee(d(order.limit_price).times(order.shares),s).minus(s.minimum_fee)):fee(amount,s);
  return amount.plus(extra);
}
export function rewardTarget(s:SmartSpec|undefined):string|null {
  if(!s)return null;
  return s.take_profit&&s.reward_target?Decimal.min(s.take_profit,s.reward_target).toFixed():s.take_profit??s.reward_target??null;
}
export function roundTripEstimate(shares:number,buyPrice:string,targetPrice:string|null,s:Settings,stopPrice:string|null=null){
  const slip=d(1).minus(s.risk_slippage_fraction);
  const entry=d(buyPrice).times(shares),buyFee=fee(entry,s),target=targetPrice===null?null:d(targetPrice).times(slip).times(shares);
  const sellFee=target===null?null:fee(target,s),tax=target===null?null:target.times(s.sell_tax_rate).ceil();
  const costs=sellFee===null?null:buyFee.plus(sellFee).plus(tax!);
  const reward=target===null?null:target.minus(entry).minus(costs!);
  const stop=stopPrice===null?null:d(stopPrice).times(slip).times(shares);
  const loss=stop===null?null:entry.minus(stop).plus(buyFee).plus(fee(stop,s)).plus(stop.times(s.sell_tax_rate).ceil());
  const gap=d(buyPrice).times(d(1).minus(s.overnight_gap_fraction)).times(slip).times(shares);
  const gapLoss=entry.minus(gap).plus(buyFee).plus(fee(gap,s)).plus(gap.times(s.sell_tax_rate).ceil());
  return {shares,buy_price:buyPrice,target_price:targetPrice,buy_fee:buyFee.toFixed(),
    estimated_sell_fee:sellFee?.toFixed()??null,estimated_sell_tax:tax?.toFixed()??null,
    estimated_total_costs:costs?.toFixed()??null,estimated_net_target_gain:reward?.toFixed()??null,
    stop_price:stopPrice,estimated_stop_loss:loss?.toFixed()??null,
    estimated_gap_loss:gapLoss.toFixed(),slippage_fraction:s.risk_slippage_fraction,
    estimated_reward_risk:reward!==null&&loss?.gt(0)?reward.div(loss).toFixed():null};
}
export function entryRiskIssues(shares:number,price:string,smart:SmartSpec|undefined,a:Account,s:Settings,symbol?:string):string[]{
  const checkStop=d(s.max_trade_risk_fraction).gt(0);
  if(!checkStop&&!d(s.max_gap_risk_fraction).gt(0))return [];
  if(checkStop&&(!smart||!d(smart.stop_price).lt(price)))return ['進場停損資料不足或不合法'];
  const estimate=roundTripEstimate(shares,price,rewardTarget(smart),s,smart?.stop_price??null);
  const issues=checkStop&&d(estimate.estimated_stop_loss!).gt(equity(a).times(s.max_trade_risk_fraction))?['超過單筆停損風險預算（含費稅與滑價）']:[];
  if(d(s.max_gap_risk_fraction).gt(0)&&d(estimate.estimated_gap_loss).gt(equity(a).times(s.max_gap_risk_fraction)))issues.push('超過隔夜跳空壓力風險預算');
  const held=symbol?a.positions.find(p=>p.symbol===symbol&&p.shares>0):undefined;
  if(held&&smart){
    const quantity=shares+held.shares,entry=d(price).times(shares);
    const basis=d(held.cost_basis??d(held.average_price).times(held.shares).plus(fee(d(held.average_price).times(held.shares),s)).toFixed()).plus(entry).plus(fee(entry,s));
    const exit=d(smart.stop_price).times(d(1).minus(s.risk_slippage_fraction)).times(quantity);
    const totalLoss=Decimal.max(0,basis.minus(exit).plus(fee(exit,s)).plus(exit.times(s.sell_tax_rate).ceil()));
    if(checkStop&&totalLoss.gt(equity(a).times(s.max_trade_risk_fraction)))issues.push('加碼後合併持倉超過停損風險預算（含既有成本）');
    const marked=d(held.last_price).times(held.shares).plus(entry);
    const gapProceeds=marked.times(d(1).minus(s.overnight_gap_fraction)).times(d(1).minus(s.risk_slippage_fraction));
    const combinedGap=marked.minus(gapProceeds).plus(fee(entry,s)).plus(fee(gapProceeds,s)).plus(gapProceeds.times(s.sell_tax_rate).ceil());
    if(d(s.max_gap_risk_fraction).gt(0)&&combinedGap.gt(equity(a).times(s.max_gap_risk_fraction)))issues.push('加碼後合併持倉超過隔夜跳空壓力預算');
  }
  return issues;
}
export function entryQualityIssues(shares:number,price:string,smart:SmartSpec|undefined,s:Settings):string[]{
  const target=rewardTarget(smart);
  if(!smart||!target||!d(smart.stop_price).lt(price)||!d(target).gt(price))return ['缺少有效停損與收益目標，無法核對扣費報酬風險比'];
  const estimate=roundTripEstimate(shares,price,target,s,smart.stop_price);
  if(!d(estimate.estimated_net_target_gain!).gt(0))return ['停利價差不足覆蓋雙邊手續費與賣出稅'];
  if(d(estimate.estimated_net_target_gain!).lt(s.min_net_profit_twd))return ['預期淨利不足最低成本效益門檻'];
  if(s.research_cost_aware&&d(estimate.estimated_net_target_gain!).lt(d(estimate.estimated_total_costs!).times(2)))return ['研究成本門檻：預期淨收益不足雙邊費稅的兩倍'];
  return d(estimate.estimated_reward_risk!).lt(s.min_entry_reward_risk)?['扣費後報酬風險比未達進場門檻']:[];
}
