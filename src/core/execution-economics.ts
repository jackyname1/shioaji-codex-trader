import {d,type Settings} from './models.js';
import {roundTripEstimate} from './costs.js';
import {roundPrice} from './risk.js';

/** Minimum legal quoted exit price covering estimated fees, sell tax and slippage, within today's price ceiling.
 * A cost threshold only: never a forecast or permission to raise a strategy's evidence-based target.
 */
export function breakEvenExitPrice(shares:number,buyPrice:string,ceiling:string,s:Settings):string|null{
  if(!Number.isSafeInteger(shares)||shares<=0||!d(buyPrice).gt(0)||d(ceiling).lt(buyPrice))return null;
  let lo=d(buyPrice).times(100).ceil().toNumber(),hi=d(ceiling).times(100).floor().toNumber();
  if(!Number.isSafeInteger(lo)||!Number.isSafeInteger(hi))return null;
  const profitable=(price:string)=>d(price).lte(ceiling)&&d(roundTripEstimate(shares,buyPrice,price,s).estimated_net_target_gain!).gte(0);
  if(!profitable(roundPrice(ceiling)))return null;
  let answer:string|null=null;
  while(lo<=hi){const mid=Math.floor((lo+hi)/2),price=roundPrice(d(mid).div(100),false);
    if(profitable(price)){answer=price;hi=mid-1;}else lo=mid+1;}
  return answer;
}
