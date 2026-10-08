import { Decimal } from 'decimal.js';
import { d, SmartSchema, type Protection, type SmartSpec } from './models.js';
export function updateProtection(existing: Protection | undefined, symbol: string, spec: SmartSpec, planId: string): Protection {
  const values = { ...spec };
  if (existing) {
    values.stop_price = Decimal.max(spec.stop_price, existing.spec.stop_price).toFixed();
    if (spec.trailing_fraction !== null && existing.spec.trailing_fraction !== null)
      values.trailing_fraction = Decimal.min(spec.trailing_fraction, existing.spec.trailing_fraction).toFixed();
    if (existing.spec.trailing_activate !== null) {
      values.trailing_activate = Decimal.min(spec.trailing_activate ?? existing.spec.trailing_activate, existing.spec.trailing_activate).toFixed();
      values.trailing_fraction ??= existing.spec.trailing_fraction;
    }
  }
  return { symbol, spec: SmartSchema.parse(values), plan_id: planId, high_water: existing?.high_water ?? '0', triggered: existing?.triggered ?? '' };
}
export function evaluate(protection: Protection, price: string): string {
  protection.high_water = Decimal.max(protection.high_water, price).toFixed();
  protection.triggered = '';
  const s = protection.spec;
  if (d(price).lte(s.stop_price)) protection.triggered = 'STOP';
  else if (s.take_profit !== null && d(price).gte(s.take_profit)) protection.triggered = 'TAKE_PROFIT';
  else if (s.trailing_activate !== null && s.trailing_fraction !== null && d(protection.high_water).gte(s.trailing_activate)
    && d(price).lte(d(protection.high_water).times(d(1).minus(s.trailing_fraction)))) protection.triggered = 'TRAILING';
  return protection.triggered;
}
