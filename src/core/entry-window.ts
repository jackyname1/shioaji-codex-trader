import {d,twDay,twClock,type Decision,type Features,type Instrument} from './models.js';
import {roundPrice,tickSize} from './risk.js';

export interface EntryWindow {minimum:string;maximum:string;width_pct:string;issue:string;narrow:boolean}
const fields={MA5:'ma5',MA20:'ma20',MA60:'ma60',RSI14:'rsi14',ATR14:'atr14',SUPPORT20:'support20',
  RESISTANCE20:'resistance20',VOLUME_RATIO20:'volume_ratio20',RETURN20:'return20'} as const;
/** A necessary price range, never sufficient authorization. Unknown/book guards remain runtime checks. */
export function entryWindow(decision:Decision,features:Features|undefined,now:Date,instrument?:Instrument):EntryWindow{
  let low=d('0.01'),high=d(decision.limit_price),strictLow=false,strictHigh=false;
  const lower=(value:string,strict=false)=>{const v=d(value),cmp=v.cmp(low);if(cmp>0){low=v;strictLow=strict;}else if(cmp===0)strictLow ||= strict;};
  const upper=(value:string,strict=false)=>{const v=d(value),cmp=v.cmp(high);if(cmp<0){high=v;strictHigh=strict;}else if(cmp===0)strictHigh ||= strict;};
  if(instrument&&twDay(new Date(instrument.verified_at))===twDay(now)){lower(instrument.limit_down);upper(instrument.limit_up);}
  if(decision.entry_when==='BELOW')upper(decision.trigger_price);
  if(decision.entry_when==='ABOVE')lower(decision.trigger_price);
  const known=features?.sufficient&&features.asof&&features.asof<=twDay(now)
    &&(features.asof!==twDay(now)||twClock(now)>='13:40');
  for(const c of decision.conditions??[]){
    if(c.left!=='LAST')continue;
    const raw=c.right==='VALUE'?c.value:c.right in fields&&known?features?.[fields[c.right as keyof typeof fields]]:undefined;
    if(raw===undefined||raw===null||typeof raw==='number'&&!Number.isFinite(raw))continue;
    const v=String(raw);
    if(c.operator==='GT'||c.operator==='GTE')lower(v,c.operator==='GT');else upper(v,c.operator==='LT');
  }
  let first=d(roundPrice(low,false)),last=d(roundPrice(high));
  if(strictLow&&first.eq(low))first=first.plus(tickSize(first));
  // Tick size below a band boundary differs from the tick at the boundary (e.g. 50 -> 49.95).
  if(strictHigh&&last.eq(high))last=d(roundPrice(last.minus('0.000001')));
  const impossible=first.gt(last),width=high.gt(0)?last.minus(first).div(high).times(100):d(0);
  return {minimum:first.toFixed(),maximum:last.toFixed(),width_pct:width.toFixed(4),
    issue:impossible?`進場價格條件無交集（LAST 最低 ${first.toFixed()}／最高 ${last.toFixed()}）；等待新策略`:'',
    narrow:!impossible&&width.lt('0.5')};
}
