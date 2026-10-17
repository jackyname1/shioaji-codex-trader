import {Decimal} from 'decimal.js';
import {SettingsSchema,d,type Settings} from './models.js';
/** User-authorized ceilings. Persisted profiles and model output cannot widen these. */
export function authorizedRisk(s:Settings):Settings {
  const minCash=Decimal.max('.25',s.min_cash_fraction);
  const cap=(value:string,ceiling:string)=>d(value).gt(ceiling)?ceiling:value;
  return SettingsSchema.parse({...s,min_cash_fraction:d(s.min_cash_fraction).lt('.25')?'0.25':s.min_cash_fraction,order_budget_basis:'AFTER_RESERVE',
    max_order_fraction:cap(s.max_order_fraction,'0.10'),
    max_symbol_fraction:cap(s.max_symbol_fraction,'0.20'),
    max_exposure_fraction:cap(cap(s.max_exposure_fraction,'0.75'),d(1).minus(minCash).toFixed()),
    max_daily_buy_fraction:cap(s.max_daily_buy_fraction,'0.20'),
    max_daily_buy_orders:Math.min(5,s.max_daily_buy_orders),daily_loss_fraction:cap(s.daily_loss_fraction,'0.02')});
}
