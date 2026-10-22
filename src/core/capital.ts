import {Decimal} from 'decimal.js';
import {active,d,equity,marketValue,remaining,SettingsSchema,type Account,type Settings} from './models.js';
import {authorizedRisk} from './risk-policy.js';
import {remainingBuyCost} from './costs.js';

export function orderBudget(e:Decimal.Value,s:Settings):Decimal{
  return d(e).times(s.order_budget_basis==='AFTER_RESERVE'?d(1).minus(s.min_cash_fraction):1).times(s.max_order_fraction);
}
export function capitalSnapshot(a:Account,s:Settings){
  const e=equity(a),buys=a.orders.filter(o=>active(o)&&o.action==='BUY');
  const principal=buys.reduce((sum,o)=>sum.plus(d(o.limit_price).times(remaining(o))),d(0));
  const reserved=buys.reduce((sum,o)=>sum.plus(remainingBuyCost(o,s)),d(0));
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
  // Legacy names remain readable; no profile may loosen a stricter saved constraint.
  if(profile==='custom')return authorizedRisk(base);
  return authorizedRisk(SettingsSchema.parse({...base,
    target_exposure_fraction:d(base.target_exposure_fraction).lte('.50')?base.target_exposure_fraction:'0.50',
    min_entry_reward_risk:d(base.min_entry_reward_risk).gte('1.2')?base.min_entry_reward_risk:'1.2',
    max_trade_risk_fraction:d(base.max_trade_risk_fraction).gt(0)&&d(base.max_trade_risk_fraction).lte('.01')?base.max_trade_risk_fraction:'0.01',
    watch_max_symbols:profile==='active'?16:base.watch_max_symbols}));
}
