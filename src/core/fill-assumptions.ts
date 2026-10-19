import {d,type Quote} from './models.js';
import {roundPrice,tickSize} from './risk.js';
export type FillAssumption='legacy'|'optimistic'|'neutral'|'conservative';
/** Sensitivity scenarios, not calibrated odd-lot queue or matching probabilities. */
export function assumedQuote(q:Quote,profile:FillAssumption,volumeKnown=true):Quote{
  if(profile==='legacy'||q.book_source==='OBSERVED')return q;
  const multiplier=profile==='optimistic'?1:profile==='neutral'?.1:.01;
  const ticks=profile==='optimistic'?0:profile==='neutral'?1:2;
  const depth=(n:number)=>profile==='conservative'&&!volumeKnown?0:Math.floor(n*multiplier);
  return {...q,bid:roundPrice(d(q.bid).minus(tickSize(q.last).times(ticks)).clamp('.01',Infinity)),
    ask:roundPrice(d(q.ask).plus(tickSize(q.last).times(ticks)),false),
    bid_shares:depth(q.bid_shares),ask_shares:depth(q.ask_shares)};
}
