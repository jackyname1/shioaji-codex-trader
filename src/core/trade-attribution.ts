import {d,type Order} from './models.js';
import type {SimulatedFill} from '../broker/paper.js';

/** Descriptive execution attribution, not a causal claim about stock-selection alpha.
 * Reconstructs FIFO from raw fill prices/quantities/charges; never trusts realized_pnl.
 * No OHLC high/low is used to invent MFE/MAE or an intrabar path.
 */
export function tradeAttribution(fills:SimulatedFill[],orders:Order[]=[]){
  type Lot={shares:number;price:string;fee:string};
  type Episode={symbol:string;entry_at:string;exit_at:string|null;buy_shares:number;sell_shares:number;
    gross_pnl:string;fees:string;taxes:string;net_pnl:string;reported_realized_pnl:string;
    reference_gross_pnl:string|null;spread_cost:string|null;modeled_price_impact:string|null;
    execution_shortfall:string|null;unattributed_price_pnl:string;exit_reasons:string[];order_ids:string[]};
  const inventory=new Map<string,Lot[]>(),active=new Map<string,Episode>(),closed:Episode[]=[],ids=new Set<string>();
  let previous=-Infinity;
  for(const f of fills){
    const at=Date.parse(f.at);if(!Number.isFinite(at)||at<previous||ids.has(f.id)||!Number.isSafeInteger(f.shares)||f.shares<=0||!d(f.price).gt(0)||d(f.fee).lt(0)||d(f.tax).lt(0))throw new Error('ATTRIBUTION_INVALID_FILL');
    previous=at;ids.add(f.id);
    let e=active.get(f.symbol);
    if(!e){if(f.action==='SELL')throw new Error('ATTRIBUTION_INVENTORY_UNDERFLOW');
      e={symbol:f.symbol,entry_at:f.at,exit_at:null,buy_shares:0,sell_shares:0,gross_pnl:'0',fees:'0',taxes:'0',net_pnl:'0',reported_realized_pnl:'0',
        reference_gross_pnl:'0',spread_cost:'0',modeled_price_impact:'0',execution_shortfall:'0',unattributed_price_pnl:'0',exit_reasons:[],order_ids:[]};active.set(f.symbol,e);}
    if(!e.order_ids.includes(f.order_id))e.order_ids.push(f.order_id);
    e.fees=d(e.fees).plus(f.fee).toFixed();e.taxes=d(e.taxes).plus(f.tax).toFixed();
    const amount=d(f.price).times(f.shares),sign=f.action==='BUY'?-1:1;
    e.gross_pnl=d(e.gross_pnl).plus(amount.times(sign)).toFixed();
    const execution=f.execution;
    if(execution){
      if(e.reference_gross_pnl!==null)e.reference_gross_pnl=d(e.reference_gross_pnl).plus(d(execution.last).times(f.shares).times(sign)).toFixed();
      const side=f.action==='BUY'?execution.ask:execution.bid;
      const shortfall=d(side).minus(execution.last).times(-sign).times(f.shares);
      if(e.execution_shortfall!==null)e.execution_shortfall=d(e.execution_shortfall).plus(shortfall).toFixed();
      if(execution.unadjusted_book){
        const raw=f.action==='BUY'?execution.unadjusted_book.ask:execution.unadjusted_book.bid;
        if(e.spread_cost!==null)e.spread_cost=d(e.spread_cost).plus(d(raw).minus(execution.last).times(-sign).times(f.shares)).toFixed();
        if(e.modeled_price_impact!==null)e.modeled_price_impact=d(e.modeled_price_impact).plus(d(side).minus(raw).times(-sign).times(f.shares)).toFixed();
      }else{e.spread_cost=null;e.modeled_price_impact=null;}
    }else{e.reference_gross_pnl=null;e.execution_shortfall=null;e.spread_cost=null;e.modeled_price_impact=null;}
    const lots=inventory.get(f.symbol)??[];
    if(f.action==='BUY'){e.buy_shares+=f.shares;lots.push({shares:f.shares,price:f.price,fee:f.fee});}
    else{
      e.sell_shares+=f.shares;let needed=f.shares,basis=d(0),buyFees=d(0);
      for(const lot of lots){const n=Math.min(lot.shares,needed);if(!n)continue;
        const fee=d(lot.fee).times(n).div(lot.shares);basis=basis.plus(d(lot.price).times(n));buyFees=buyFees.plus(fee);
        lot.fee=d(lot.fee).minus(fee).toFixed();lot.shares-=n;needed-=n;
      }
      if(needed)throw new Error('ATTRIBUTION_INVENTORY_UNDERFLOW');
      e.net_pnl=d(e.net_pnl).plus(amount.minus(basis).minus(buyFees).minus(f.fee).minus(f.tax)).toFixed();
      e.reported_realized_pnl=d(e.reported_realized_pnl).plus(f.realized_pnl??0).toFixed();
      const reason=f.exit_trigger??orders.find(o=>o.local_id===f.order_id)?.exit_trigger??'EXPLICIT';if(!e.exit_reasons.includes(reason))e.exit_reasons.push(reason);
      if(lots.every(l=>!l.shares)){
        e.exit_at=f.at;e.unattributed_price_pnl=e.reference_gross_pnl??e.gross_pnl;closed.push(e);active.delete(f.symbol);
      }
    }
    inventory.set(f.symbol,lots.filter(l=>l.shares>0));
  }
  const byExit=Object.fromEntries([...new Set(closed.flatMap(e=>e.exit_reasons.length===1?e.exit_reasons:['MIXED']))].map(reason=>{
    const rows=closed.filter(e=>(e.exit_reasons.length===1?e.exit_reasons[0]:'MIXED')===reason);
    return [reason,{trades:rows.length,net_pnl:rows.reduce((sum,e)=>sum.plus(e.net_pnl),d(0)).toFixed()}];}));
  return {version:1,method:'FIFO raw fills; flat-to-flat completed symbol episodes; open positions excluded',
    limitation:'選股、進場時機與市場因果無法單靠成交識別；reference_gross_pnl 為成交時最後價的描述性殘差。spread_cost 為未施加情境的報價差；modeled_price_impact 含設定滑價、情境加價與 tick rounding，未宣稱為實測滑價。舊成交未提供報價則保持 null。',
    closed,open:[...active.values()].map(e=>({...e,gross_pnl:'UNMARKED',unattributed_price_pnl:'UNMARKED'})),by_exit:byExit,
    reconciled:closed.every(e=>d(e.net_pnl).minus(e.reported_realized_pnl).abs().lte('.02')&&d(e.gross_pnl).minus(e.fees).minus(e.taxes).minus(e.net_pnl).abs().lte('.02')
      &&(e.reference_gross_pnl===null||e.execution_shortfall===null||d(e.reference_gross_pnl).minus(e.execution_shortfall).minus(e.gross_pnl).abs().lte('.02')))};
}
