import { Decimal } from 'decimal.js';
import { d, SmartSchema, type Protection, type SmartSpec, type EntryTrack, type Decision, type Quote } from './models.js';
export const entrySignalKey=(decision:Decision):string=>JSON.stringify([decision.symbol,decision.entry_when,decision.trigger_price,
  decision.limit_price,decision.rebound_fraction,decision.smart?.stop_price,decision.conditions??[],decision.entry_strategy??'MODEL']);
export const trailingArmed=(p:Protection):boolean=>p.trailing_armed??(p.spec.trailing_activate!==null&&d(p.high_water).gte(p.spec.trailing_activate));
export const trailingExit=(p:Protection):string|null=>trailingArmed(p)&&p.spec.trailing_fraction
  ?Decimal.max(p.protective_floor??0,d(p.high_water).minus(Decimal.max(d(p.high_water).times(p.spec.trailing_fraction),p.spec.trailing_atr??0))).toFixed():null;
export const reboundExit=(t:EntryTrack|undefined,decision:Decision):string|null=>t?.armed&&decision.rebound_fraction
  ?d(t.low_water).times(d(1).plus(decision.rebound_fraction)).toFixed():null;
/** Only observed trades enter the state; never infer an OHLC bar's intraminute path. */
export function trackEntry(existing:EntryTrack|undefined,decision:Decision,planId:string,q:Quote,createdAt:string,guards=true):EntryTrack {
  const lot=q.odd?'ODD':'COMMON',key=entrySignalKey(decision);
  const same=existing?.symbol===decision.symbol&&existing.lot===lot
    &&(existing.plan_id===planId||existing.signal_key===key&&!!existing.expires_at&&Date.parse(existing.expires_at)>Date.parse(createdAt));
  const t:EntryTrack=same?{...existing!,plan_id:planId}:{symbol:decision.symbol,plan_id:planId,lot,armed:false,low_water:'0',observed_at:null,
    signal_key:key,strategy:decision.entry_strategy,started_at:createdAt,state:'WAITING',confirmations:0,confirmation_at:null,
    ...(decision.tracking_timeout_minutes?{expires_at:new Date(Math.max(Date.parse(createdAt),Date.parse(q.trade_at))+decision.tracking_timeout_minutes*60000).toISOString()}: {})};
  if(Date.parse(q.trade_at)<Date.parse(createdAt)||t.observed_at&&Date.parse(q.trade_at)<=Date.parse(t.observed_at))return t;
  const previousPrice=t.last_price;t.last_price=q.last;
  t.observed_at=q.trade_at;
  if(t.expires_at&&Date.parse(q.trade_at)>=Date.parse(t.expires_at)){t.state='EXPIRED';return t;}
  if(t.state==='EXPIRED'||t.state==='INVALID')return t;
  if(decision.tracking_timeout_minutes&&decision.smart&&d(q.last).lte(decision.smart.stop_price)){t.state='INVALID';return t;}
  if(decision.entry_when==='REBOUND'){
    if(!t.armed&&d(q.last).lte(decision.trigger_price)){t.armed=true;t.low_water=q.last;t.state='TRACKING';}
    else if(t.armed)t.low_water=Decimal.min(t.low_water,q.last).toFixed();
  }
  const momentum=decision.entry_strategy!=='TREND_CONTINUATION'||!previousPrice||d(q.last).gte(previousPrice);
  const ready=guards&&momentum&&(decision.entry_when==='REBOUND'?t.armed&&d(q.last).gte(reboundExit(t,decision)!):
    decision.entry_when==='ABOVE'?d(q.last).gte(decision.trigger_price):decision.entry_when==='BELOW'?d(q.last).lte(decision.trigger_price):true);
  if(ready){t.confirmations=(t.confirmations??0)+1;t.confirmation_at??=q.trade_at;
    t.state=t.confirmations>=(decision.confirmation_ticks??1)&&Date.parse(q.trade_at)-Date.parse(t.confirmation_at)>=(decision.confirmation_seconds??0)*1000?'READY':'CONFIRMING';}
  else {t.confirmations=0;t.confirmation_at=null;t.state=t.armed?'TRACKING':'WAITING';}
  return t;
}
export function entryReady(decision:Decision,price:string,t?:EntryTrack):boolean {
  if(t?.state==='INVALID'||t?.state==='EXPIRED')return false;
  if((decision.confirmation_ticks??1)>1&&t?.state!=='READY')return false;
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
  return { ...existing,symbol, spec: SmartSchema.parse(values), plan_id: planId, high_water: existing?.high_water ?? '0', triggered: existing?.triggered ?? '',
    trailing_armed:existing?trailingArmed(existing):false,observed_at:existing?.observed_at??null };
}
export function evaluate(protection: Protection, price: string,tradeAt?:string): string {
  if(tradeAt&&protection.observed_at&&Date.parse(tradeAt)<Date.parse(protection.observed_at))return '';
  protection.trailing_armed=trailingArmed(protection);
  if(tradeAt)protection.observed_at=tradeAt;
  const latched=protection.latch_exit?protection.triggered:'';
  protection.triggered = '';
  const s = protection.spec;
  // Record every observed post-entry trade, even before activation.
  if(protection.latch_exit)protection.high_water=Decimal.max(protection.high_water,price).toFixed();
  if(s.trailing_activate!==null&&d(price).gte(s.trailing_activate))protection.trailing_armed=true;
  if(protection.trailing_armed)protection.high_water=Decimal.max(protection.high_water,price).toFixed();
  if(s.breakeven_activate&&s.breakeven_price&&d(price).gte(s.breakeven_activate))protection.breakeven_armed=true;
  if(protection.latch_exit){
    let floor=Decimal.max(protection.protective_floor??0,s.stop_price);
    if(protection.breakeven_armed&&s.breakeven_price)floor=Decimal.max(floor,s.breakeven_price);
    const trailing=trailingExit(protection);if(trailing)floor=Decimal.max(floor,trailing);
    protection.protective_floor=floor.toFixed();
  }
  if (d(price).lte(s.stop_price)) protection.triggered = 'STOP';
  else if(protection.latch_exit&&protection.protective_floor&&d(price).lte(protection.protective_floor))
    protection.triggered=protection.trailing_armed?'TRAILING':'BREAKEVEN';
  else if (s.take_profit !== null && d(price).gte(s.take_profit)) protection.triggered = 'TAKE_PROFIT';
  else if (s.trailing_activate !== null && s.trailing_fraction !== null && protection.trailing_armed
    && d(price).lte(d(protection.high_water).times(d(1).minus(s.trailing_fraction)))) protection.triggered = 'TRAILING';
  protection.triggered ||= latched;
  if(latched==='STOP')protection.triggered='STOP';
  return protection.triggered;
}
