import {Decimal} from 'decimal.js';
import {d,equity,SettingsSchema,twDay,type Account,type Decision,type Features,type Position,type Protection,type Quote,type Settings} from './models.js';
import {roundPrice,tickSize,fee} from './risk.js';
import {rewardTarget,roundTripEstimate} from './costs.js';
import {updateProtection} from './smart.js';

export type Optimization='baseline'|'entries'|'exits'|'allocation'|'integrated';
export const adaptiveLimits=(s:Settings):Record<string,unknown>=>Object.fromEntries([
  'adaptive_entries','adaptive_exits','dynamic_allocation','exit_slippage_fraction','simulation_slippage_fraction',
  'gap_stress_fraction','max_gap_risk_fraction','min_net_reward_twd','min_reward_cost_multiple','breakeven_r_multiple',
  'trailing_atr_multiple','entry_tracking_minutes'].map(k=>[k,s[k as keyof Settings]]));
export function costAwareSettings(base:Settings,enabled:boolean):Settings{
  return enabled?SettingsSchema.parse({...base,exit_slippage_fraction:'0.001',gap_stress_fraction:'0.03',
    max_gap_risk_fraction:'0.025',min_net_reward_twd:'80',min_reward_cost_multiple:'2'}):base;
}
/** Explicit replay/paper opt-in. Never changes execution authority or saved live settings. */
export function optimizationSettings(base:Settings,mode:Optimization):Settings{
  return SettingsSchema.parse({...base,adaptive_entries:mode==='entries'||mode==='integrated',
    adaptive_exits:mode==='exits'||mode==='integrated',dynamic_allocation:mode==='allocation'||mode==='integrated'});
}
const clamp=(x:Decimal,min:Decimal.Value,max:Decimal.Value):Decimal=>Decimal.max(min,Decimal.min(max,x));
const guard=(left:'LAST'|'ASK'|'MA5'|'MA20'|'RSI14'|'VOLUME_RATIO20',operator:'GTE'|'LTE',value:string)=>({left,operator,right:'VALUE' as const,value});
/** Setups freeze their ceiling/stop/target on first observation in a plan; no target lifting to pass RR. */
export function adaptiveSetups(symbol:string,f:Features|undefined,q:Quote,now:Date,s?:Settings):Decision[]{
  if(!f?.sufficient||!f.asof||f.asof>=twDay(now)||![f.ma5,f.ma20,f.ma60,f.atr14,f.support20,f.resistance20,f.rsi14,f.volume_ratio20]
    .every(v=>v!==undefined&&Number.isFinite(v))||!f.atr14||!f.ma20||!f.ma60||!f.support20||!f.resistance20)return [];
  if(f.ma5!<f.ma20||f.ma20<f.ma60||f.rsi14!<40||f.rsi14!>74||f.volume_ratio20!<.8)return [];
  const atr=d(f.atr14),last=d(q.last),ma=d(f.ma20),res=d(f.resistance20),support=d(f.support20),out:Decision[]=[];
  const add=(kind:Decision['entry_strategy'],trigger:Decimal,ceiling:Decimal,stop:Decimal,target:Decimal,rebound:string|null=null)=>{
    const limit=roundPrice(ceiling),sl=roundPrice(stop),tp=roundPrice(target);
    const requiredFloor=kind==='BREAKOUT_CONFIRM'?Decimal.max(trigger,f.ma60!):d(f.ma60!);
    if(!d(sl).gt(0)||!d(sl).lt(limit)||!d(tp).gt(limit)||!trigger.gt(0)
      ||d(roundPrice(requiredFloor,false)).gt(limit))return;
    out.push({symbol,action:'BUY',shares:1,limit_price:limit,entry_when:kind==='PULLBACK_REBOUND'?'REBOUND':kind==='BREAKOUT_CONFIRM'?'ABOVE':'IMMEDIATE',
      trigger_price:roundPrice(trigger,false),rebound_fraction:rebound,entry_strategy:kind,tracking_timeout_minutes:s?.entry_tracking_minutes??120,
      confirmation_ticks:2,confirmation_seconds:30,smart:{stop_price:sl,take_profit:tp,trailing_activate:null,trailing_fraction:null,reward_target:tp},
      conditions:[guard('LAST','GTE',f.ma60!.toString()),guard('ASK','LTE',limit),guard('RSI14','LTE','74'),guard('VOLUME_RATIO20','GTE',kind==='BREAKOUT_CONFIRM'?'1.2':'0.8')],
      reason:({PULLBACK_REBOUND:'回檔反彈',TREND_CONTINUATION:'趨勢延續',BREAKOUT_CONFIRM:'突破確認'}[kind!]??kind)+'：已完成日均線／量能合格；以不同時間的實際價格確認，目標由既有壓力或固定區間量度生成，不隨風控拒絕上調'});
  };
  if(last.gte(f.ma5!)&&last.gte(ma)&&last.minus(ma).lte(atr.times(2))&&d(f.ma5!).gte(ma)){
    const ceiling=last.plus(atr.times('.25'));
    add('TREND_CONTINUATION',last,ceiling,Decimal.max(support,ceiling.minus(atr.times('1.5'))),
      Decimal.min(res.minus(tickSize(res)),last.plus(atr.times(3))));
    const trend=out.find(d=>d.entry_strategy==='TREND_CONTINUATION');
    if(trend)trend.conditions!.push(guard('LAST','GTE',f.ma5!.toString()));
  }
  if(last.minus(ma).abs().lte(atr.times('1.5'))&&last.gte(support)){
    const trigger=Decimal.min(last,ma.plus(atr.times('.5'))),rebound=clamp(atr.times('.35').div(trigger),'.004','.02');
    const ceiling=trigger.times(d(1).plus(rebound)).plus(atr.times('.25'));
    add('PULLBACK_REBOUND',trigger,ceiling,Decimal.max(support,trigger.minus(atr.times('1.5'))),
      Decimal.min(res.minus(tickSize(res)),ceiling.plus(atr.times(3))),rebound.toFixed());
  }
  if(last.gte(res.minus(atr))&&last.lte(res.plus(atr.times('.5')))&&f.volume_ratio20!>=1.2){
    const trigger=res.plus(tickSize(res));
    add('BREAKOUT_CONFIRM',trigger,res.plus(atr.times('.5')),Decimal.max(ma,res.minus(atr.times('1.25'))),
      res.plus(Decimal.min(res.minus(support).times('.5'),atr.times(3))));
  }
  return out;
}
export function signalScore(decision:Decision,f:Features|undefined,s:Settings):number{
  const price=decision.limit_price,estimate=roundTripEstimate(Math.max(1,Math.floor(20000/Number(price))),price,rewardTarget(decision.smart??undefined),s,decision.smart?.stop_price??null);
  const rr=Number(estimate.estimated_reward_risk??0),volume=Math.min(2,f?.volume_ratio20??0);
  return Math.max(0,Math.min(1,.25+Math.min(3,Math.max(0,rr))*.15+volume*.1+
    (decision.entry_strategy==='BREAKOUT_CONFIRM'?.1:decision.entry_strategy==='PULLBACK_REBOUND'?.08:.05)));
}
export function preferredAllocation(decision:Decision,a:Account,s:Settings,f?:Features):string{
  const gap=Decimal.max(0,equity(a).times(s.target_exposure_fraction).minus(
    a.positions.reduce((sum,p)=>sum.plus(d(p.last_price).times(p.shares)),d(0)))
    .minus(a.orders.filter(o=>!['FILLED','CANCELLED','REJECTED'].includes(o.status)&&o.action==='BUY')
      .reduce((sum,o)=>sum.plus(d(o.limit_price).times(o.shares-o.filled)),d(0))));
  return Decimal.min(gap,equity(a).times(s.max_order_fraction).times(d('.55').plus(d(signalScore(decision,f,s)).times('.45')))).toFixed();
}
/** Estimated floor covers known/estimated buy cost, exit fee, tax and configured adverse exit slippage. */
export function breakEvenPrice(position:Position,s:Settings,basis?:string):string{
  const cost=basis?d(basis):d(position.average_price).times(position.shares).plus(fee(d(position.average_price).times(position.shares),s));
  let price=roundPrice(cost.plus(s.minimum_fee).div(position.shares).div(d(1).minus(s.sell_tax_rate).minus(s.fee_rate))
    .div(d(1).minus(s.exit_slippage_fraction)),false);
  for(let n=0;n<100;n++){
    const amount=d(price).times(position.shares).times(d(1).minus(s.exit_slippage_fraction));
    if(amount.minus(fee(amount,s)).minus(amount.times(s.sell_tax_rate).ceil()).gte(cost))return price;
    price=roundPrice(d(price).plus(tickSize(price)),false);
  }
  throw new Error('無法核對保本費用');
}
export function adaptiveProtection(p:Protection,position:Position,f:Features|undefined,s:Settings,basis?:string):Protection{
  if(!s.adaptive_exits||position.shares<=0||!d(position.average_price).gt(0))return p;
  const entry=d(position.average_price),atr=f?.atr14&&f.sufficient?d(f.atr14):entry.times('.025'),risk=Decimal.max(atr,entry.minus(p.spec.stop_price));
  const be=breakEvenPrice(position,s,basis),activation=Decimal.max(entry.plus(risk),entry.plus(atr));
  const target=rewardTarget(p.spec),boundedActivation=target&&d(target).gt(entry)?Decimal.min(activation,entry.plus(d(target).minus(entry).times('.65'))):activation;
  const spec={...p.spec,trailing_activate:p.spec.trailing_activate??roundPrice(boundedActivation,false),
    trailing_fraction:p.spec.trailing_fraction??clamp(atr.times(s.trailing_atr_multiple).div(entry),'.025','.08').toFixed(),
    trailing_atr:p.spec.trailing_atr??atr.times(s.trailing_atr_multiple).toFixed(),
    breakeven_activate:p.spec.breakeven_activate??roundPrice(Decimal.max(entry.plus(risk.times(s.breakeven_r_multiple)),d(be).plus(atr.times('.25'))),false),
    breakeven_price:Decimal.max(p.spec.breakeven_price??0,be).toFixed()};
  return {...updateProtection(p,p.symbol,spec,p.plan_id),latch_exit:true,
    protective_floor:Decimal.max(p.protective_floor??0,p.spec.stop_price).toFixed()};
}
