import { Decimal } from 'decimal.js';
import { d, SmartSchema, type Protection, type SmartSpec, type EntryTrack, type Decision, type Quote } from './models.js';
export const trailingArmed=(p:Protection):boolean=>p.trailing_armed??(p.spec.trailing_activate!==null&&d(p.high_water).gte(p.spec.trailing_activate));
export const trailingExit=(p:Protection):string|null=>trailingArmed(p)&&p.spec.trailing_fraction
  ?d(p.high_water).times(d(1).minus(p.spec.trailing_fraction)).toFixed():null;
export const reboundExit=(t:EntryTrack|undefined,decision:Decision):string|null=>t?.armed&&decision.rebound_fraction
  ?d(t.low_water).times(d(1).plus(decision.rebound_fraction)).toFixed():null;
/** Only observed trades enter the state; never infer an OHLC bar's intraminute path. */
export function trackEntry(existing:EntryTrack|undefined,decision:Decision,planId:string,q:Quote,createdAt:string):EntryTrack {
  const lot=q.odd?'ODD':'COMMON';
  const t:EntryTrack=existing?.plan_id===planId&&existing.symbol===decision.symbol&&existing.lot===lot
    ?{...existing}:{symbol:decision.symbol,plan_id:planId,lot,armed:false,low_water:'0',observed_at:null};
  if(decision.entry_when!=='REBOUND'||Date.parse(q.trade_at)<Date.parse(createdAt)
    ||t.observed_at&&Date.parse(q.trade_at)<=Date.parse(t.observed_at))return t;
  t.observed_at=q.trade_at;
  if(!t.armed&&d(q.last).lte(decision.trigger_price)){t.armed=true;t.low_water=q.last;}
  else if(t.armed)t.low_water=Decimal.min(t.low_water,q.last).toFixed();
  return t;
}
export function entryReady(decision:Decision,price:string,t?:EntryTrack):boolean {
  if(decision.entry_when==='BELOW')return d(price).lte(decision.trigger_price);
  if(decision.entry_when==='ABOVE')return d(price).gte(decision.trigger_price);
  if(decision.entry_when==='REBOUND'){const threshold=reboundExit(t,decision);return threshold!==null&&d(price).gte(threshold);}
  return true;
}
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
  return { symbol, spec: SmartSchema.parse(values), plan_id: planId, high_water: existing?.high_water ?? '0', triggered: existing?.triggered ?? '',
    trailing_armed:existing?trailingArmed(existing):false,observed_at:existing?.observed_at??null };
}
export function evaluate(protection: Protection, price: string,tradeAt?:string): string {
  if(tradeAt&&protection.observed_at&&Date.parse(tradeAt)<Date.parse(protection.observed_at))return '';
  protection.trailing_armed=trailingArmed(protection);
  if(tradeAt)protection.observed_at=tradeAt;
  protection.triggered = '';
  const s = protection.spec;
  if(s.trailing_activate!==null&&d(price).gte(s.trailing_activate))protection.trailing_armed=true;
  if(protection.trailing_armed)protection.high_water = Decimal.max(protection.high_water, price).toFixed();
  if (d(price).lte(s.stop_price)) protection.triggered = 'STOP';
  else if (s.take_profit !== null && d(price).gte(s.take_profit)) protection.triggered = 'TAKE_PROFIT';
  else if (s.trailing_activate !== null && s.trailing_fraction !== null && protection.trailing_armed
    && d(price).lte(d(protection.high_water).times(d(1).minus(s.trailing_fraction)))) protection.triggered = 'TRAILING';
  return protection.triggered;
}
