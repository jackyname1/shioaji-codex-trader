import { Decimal } from 'decimal.js';
import { d, SmartSchema, type Protection, type SmartSpec, type EntryTrack, type Decision, type Quote, type Position, type Settings } from './models.js';
import {fee} from './costs.js';
import {roundPrice,tickSize} from './risk.js';
export const trailingArmed=(p:Protection):boolean=>p.trailing_armed??(p.spec.trailing_activate!==null&&d(p.high_water).gte(p.spec.trailing_activate));
export const trailingExit=(p:Protection):string|null=>trailingArmed(p)&&p.spec.trailing_fraction
  ?Decimal.max(p.protected_floor??0,d(p.high_water).minus(Decimal.max(d(p.high_water).times(p.spec.trailing_fraction),p.trailing_distance??0))).toFixed():null;
export const reboundExit=(t:EntryTrack|undefined,decision:Decision):string|null=>t?.armed&&decision.rebound_fraction
  ?d(t.low_water).times(d(1).plus(decision.rebound_fraction)).toFixed():null;
/** Only observed trades enter the state; never infer an OHLC bar's intraminute path. */
export function trackEntry(existing:EntryTrack|undefined,decision:Decision,planId:string,q:Quote,createdAt:string,minutes=90):EntryTrack {
  const lot=q.odd?'ODD':'COMMON';
  const t:EntryTrack=existing?.plan_id===planId&&existing.symbol===decision.symbol&&existing.lot===lot
    ?{...existing}:{symbol:decision.symbol,plan_id:planId,lot,armed:false,low_water:'0',observed_at:null};
  if(decision.entry_when!=='REBOUND'||Date.parse(q.trade_at)<Date.parse(createdAt)
    ||t.observed_at&&Date.parse(q.trade_at)<=Date.parse(t.observed_at))return t;
  t.started_at??=q.trade_at;t.expires_at??=new Date(Date.parse(t.started_at)+minutes*60000).toISOString();
  if(Date.parse(q.trade_at)>Date.parse(t.expires_at)){t.armed=false;t.status='EXPIRED';return t;}
  if(t.status==='EXPIRED'||t.status==='INVALID')return t;
  if(decision.smart&&d(q.last).lte(decision.smart.stop_price)){t.armed=false;t.status='INVALID';return t;}
  t.observed_at=q.trade_at;
  if(!t.armed&&d(q.last).lte(decision.trigger_price)){t.armed=true;t.low_water=q.last;}
  else if(t.armed)t.low_water=Decimal.min(t.low_water,q.last).toFixed();
  t.status=t.armed?'TRACKING':'WAIT';
  if(t.armed&&decision.rebound_fraction&&d(q.last).gte(d(t.low_water).times(d(1).plus(decision.rebound_fraction))))t.status='TRIGGERED';
  return t;
}
export function entryReady(decision:Decision,price:string,t?:EntryTrack):boolean {
  if(decision.entry_when==='BELOW')return d(price).lte(decision.trigger_price);
  if(decision.entry_when==='ABOVE')return d(price).gte(decision.trigger_price);
  if(decision.entry_when==='REBOUND'){const threshold=reboundExit(t,decision);return t?.status!=='EXPIRED'&&t?.status!=='INVALID'&&threshold!==null&&d(price).gte(threshold);}
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
  return { ...existing, symbol, spec: SmartSchema.parse(values), plan_id: planId, high_water: existing?.high_water ?? '0', triggered: existing?.triggered ?? '',
    trailing_armed:existing?trailingArmed(existing):false,observed_at:existing?.observed_at??null };
}
/** Cost-aware local defaults. Targets remain unchanged; the protection floor can only rise. */
export function adaptProtection(p:Protection,position:Position,atr:number|undefined,s:Settings,bidCushion='0'):void {
  if(s.research_exit_mode==='fixed')return;
  if(!s.adaptive_protection||position.shares<=0||!d(position.average_price).gt(0))return;
  const entry=d(position.average_price),vol=atr&&Number.isFinite(atr)&&atr>0?d(atr):entry.times('.02');
  p.entry_price=entry.toFixed();p.initial_risk??=Decimal.max(entry.minus(p.spec.stop_price),vol).toFixed();
  const basis=position.cost_basis?d(position.cost_basis):entry.times(position.shares).plus(fee(entry.times(position.shares),s));
  let breakEven=basis.plus(fee(basis,s)).div(position.shares).div(d(1).minus(s.sell_tax_rate));
  // Solve the fee/tax fixed point conservatively, allowing integer charge rounding.
  for(let i=0;i<5;i++)breakEven=basis.plus(fee(breakEven.times(position.shares),s))
    .plus(breakEven.times(position.shares).times(s.sell_tax_rate).ceil()).div(position.shares);
  p.break_even_price=breakEven.plus('0.01').toFixed();
  p.break_even_floor=roundPrice(d(p.break_even_price).div(d(1).minus(s.risk_slippage_fraction)).plus(Decimal.max(tickSize(entry),bidCushion)),false);
  const gain=d(p.high_water).minus(entry),arm=Decimal.max(p.initial_risk,vol.times('1.25'),entry.times('.02'));
  if(gain.gte(arm))p.break_even_armed=true;
  p.protected_floor=Decimal.max(p.protected_floor??0,p.spec.stop_price,p.break_even_armed?p.break_even_floor:0).toFixed();
  if(p.spec.trailing_activate===null){
    p.spec.trailing_activate=entry.plus(Decimal.max(d(p.initial_risk).times('1.25'),vol.times('1.5'),entry.times('.025'))).toFixed();
    p.spec.trailing_fraction=Decimal.max('.02',Decimal.min('.08',vol.times('1.8').div(entry))).toFixed();
  }
  // ATR defaults never widen an explicitly tighter percentage trail.
  p.trailing_distance=Decimal.min(vol.times('1.8'),entry.times(p.spec.trailing_fraction!)).toFixed();
}
export function evaluate(protection: Protection, price: string,tradeAt?:string): string {
  if(tradeAt&&protection.observed_at&&Date.parse(tradeAt)<Date.parse(protection.observed_at))return '';
  protection.trailing_armed=trailingArmed(protection);
  if(tradeAt)protection.observed_at=tradeAt;
  protection.triggered = '';
  const s = protection.spec;
  if(s.trailing_activate!==null&&d(price).gte(s.trailing_activate))protection.trailing_armed=true;
  protection.high_water = Decimal.max(protection.high_water, price).toFixed();
  const trailing=trailingExit(protection);
  if(trailing)protection.protected_floor=Decimal.max(protection.protected_floor??0,trailing).toFixed();
  if (d(price).lte(s.stop_price)) protection.triggered = 'STOP';
  else if(protection.protected_floor&&d(price).lte(protection.protected_floor))protection.triggered=protection.break_even_armed&&d(protection.protected_floor).lte(protection.break_even_floor??protection.break_even_price??0)?'BREAKEVEN':'TRAILING';
  else if (s.take_profit !== null && d(price).gte(s.take_profit)) protection.triggered = 'TAKE_PROFIT';
  else if (s.trailing_activate !== null && s.trailing_fraction !== null && protection.trailing_armed
    && trailing!==null&&d(price).lte(trailing)) protection.triggered = 'TRAILING';
  return protection.triggered;
}

/** Opt-in paper/replay exit hypothesis. Reward forecasts remain independent of activation prices. */
export function researchExit(spec:SmartSpec,entry:string,atr:number|undefined,s:Settings):SmartSpec {
  if(s.research_exit_mode==='baseline')return spec;
  if(s.research_exit_mode==='fixed')return {...spec,take_profit:spec.take_profit??spec.reward_target??null,trailing_activate:null,trailing_fraction:null};
  if(!atr||!Number.isFinite(atr)||atr<=0)return spec;
  return {...spec,take_profit:null,reward_target:spec.reward_target??spec.take_profit,
    trailing_activate:d(entry).plus(Decimal.max(d(entry).minus(spec.stop_price).times('1.25'),d(atr).times('1.5'))).toFixed(),
    trailing_fraction:Decimal.min('.08',Decimal.max('.02',d(atr).times('1.8').div(entry))).toFixed()};
}
