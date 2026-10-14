import {Decimal} from 'decimal.js';
import {active,d,equity,marketValue,remaining,SettingsSchema,type Account,type Settings} from './models.js';
import {fee} from './costs.js';

export function orderBudget(e:Decimal.Value,s:Settings):Decimal{
  return d(e).times(s.order_budget_basis==='AFTER_RESERVE'?d(1).minus(s.min_cash_fraction):1).times(s.max_order_fraction);
}
export function capitalSnapshot(a:Account,s:Settings){
  const e=equity(a),buys=a.orders.filter(o=>active(o)&&o.action==='BUY');
  const principal=buys.reduce((sum,o)=>sum.plus(d(o.limit_price).times(remaining(o))),d(0));
  const reserved=buys.reduce((sum,o)=>{const amount=d(o.limit_price).times(remaining(o));return sum.plus(amount).plus(fee(amount,s));},d(0));
  const exposure=marketValue(a).plus(principal),target=e.times(Decimal.min(s.target_exposure_fraction,s.max_exposure_fraction));
  const gap=Decimal.max(0,target.minus(exposure));
  return {order_budget_basis:s.order_budget_basis,order_limit_twd:orderBudget(e,s).toFixed(),
    symbol_limit_twd:e.times(s.max_symbol_fraction).toFixed(),exposure_limit_twd:e.times(s.max_exposure_fraction).toFixed(),
    daily_buy_limit_twd:e.times(s.max_daily_buy_fraction).toFixed(),minimum_cash_reserve_twd:e.times(s.min_cash_fraction).toFixed(),
    reserved_buy_principal_twd:principal.toFixed(),reserved_buy_cash_twd:reserved.toFixed(),exposure_twd:exposure.toFixed(),
    exposure_fraction:e.gt(0)?exposure.div(e).toFixed():'0',target_exposure_twd:target.toFixed(),target_gap_twd:gap.toFixed(),
    preferred_order_twd:Decimal.min(orderBudget(e,s),gap).toFixed(),
    max_trade_loss_twd:d(s.max_trade_risk_fraction).gt(0)?e.times(s.max_trade_risk_fraction).toFixed():null,
    min_entry_reward_risk:s.min_entry_reward_risk};
}
export type CapitalSnapshot=ReturnType<typeof capitalSnapshot>;
export function replayCapitalSettings(base:Settings,profile:'active'|'balanced'|'custom'):Settings{
  if(profile==='active')return SettingsSchema.parse({...base,order_budget_basis:'EQUITY',max_order_fraction:'0.20',
    min_cash_fraction:'0.20',max_symbol_fraction:'0.25',max_exposure_fraction:'0.80',max_daily_buy_fraction:'0.60',
    max_daily_buy_orders:8,target_exposure_fraction:'0.70',min_entry_reward_risk:'1.2',max_trade_risk_fraction:'0.0125',watch_max_symbols:16});
  return profile==='custom'?base:SettingsSchema.parse({...base,order_budget_basis:'EQUITY',max_order_fraction:'0.15',
    max_daily_buy_fraction:'0.40',target_exposure_fraction:'0.50',min_entry_reward_risk:'1.2',max_trade_risk_fraction:'0.01'});
}
