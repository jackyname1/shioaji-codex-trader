import {d,type Settings} from './models.js';
import {fee,roundTripEstimate} from './costs.js';
import {roundPrice} from './risk.js';

/** Minimum legal quoted exit price covering estimated fees, sell tax and slippage, within today's price ceiling.
 * A cost threshold only: never a forecast or permission to raise a strategy's evidence-based target.
 */
export function breakEvenExitPrice(shares:number,buyPrice:string,ceiling:string,s:Settings):string|null{
  if(!Number.isSafeInteger(shares)||shares<=0||!d(buyPrice).gt(0)||d(ceiling).lt(buyPrice))return null;
  if(d(s.fee_rate).plus(s.sell_tax_rate).gte(1))return null;
  const entry=d(buyPrice).times(shares),slip=d(1).minus(s.risk_slippage_fraction);
  let required=entry.plus(fee(entry,s)).plus(s.minimum_fee);
  // Ceil-rounded fee/tax steps make net P/L non-monotone near break-even. A binary search can skip an
  // earlier profitable tick. Each failed candidate instead gives a proven lower bound on all later costs.
  for(let n=0;n<512;n++){
    const price=roundPrice(required.div(shares).div(slip),false);
    if(d(price).gt(ceiling))return null;
    const estimate=roundTripEstimate(shares,buyPrice,price,s),net=d(estimate.estimated_net_target_gain!);
    if(net.gte(0))return price;
    required=d(price).times(slip).times(shares).minus(net);
  }
  return null; // Fail closed on an extreme fee configuration; never return an unverified price.
}
