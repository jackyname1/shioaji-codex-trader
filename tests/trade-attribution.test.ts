import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tradeAttribution} from '../src/core/trade-attribution.js';
import {tradeStatistics} from '../src/core/performance.js';
import type {SimulatedFill} from '../src/broker/paper.js';
const fill=(id:string,action:'BUY'|'SELL',shares:number,price:string,fee:string,tax:string,realized_pnl:string|null):SimulatedFill=>({id,order_id:id,at:'2026-10-'+(action==='BUY'?'08':'09')+'T03:00:00Z',symbol:'9001',action,lot:'ODD',purpose:'ENTRY',shares,price,amount:String(shares*Number(price)),fee,tax,realized_pnl});
test('FIFO grouping independently recalculates costs, partial sells and repeated entries',()=>{
 const rows=[fill('a','BUY',100,'30','20','0',null),fill('b','BUY',100,'40','20','0',null),
   fill('c','SELL',150,'50','20','23','2427'),fill('d','SELL',50,'45','20','7','213')];
 const r=tradeAttribution(rows);assert.equal(r.closed.length,1);assert.equal(r.closed[0]!.net_pnl,'2640');assert.equal(r.closed[0]!.gross_pnl,'2750');
 assert.equal(r.closed[0]!.fees,'80');assert.equal(r.closed[0]!.taxes,'30');assert.equal(r.reconciled,true);
 assert.equal(r.closed[0]!.spread_cost,null);assert.equal(r.closed[0]!.modeled_price_impact,null);
 rows[2]!.realized_pnl='999999';assert.equal(tradeAttribution(rows).reconciled,false);assert.equal(tradeStatistics(rows).expectancy,'2640.0000');
});
test('signed quote spread and model price impact reconcile separately from fees without claiming market alpha',()=>{
 const buy=fill('a','BUY',100,'30.2','20','0',null),sell=fill('b','SELL',100,'32.8','20','10','210');
 buy.execution={last:'30',bid:'29.8',ask:'30.2',trade_at:buy.at,book_at:buy.at,unadjusted_book:{bid:'29.9',ask:'30.1'}};
 sell.execution={last:'33',bid:'32.8',ask:'33.2',trade_at:sell.at,book_at:sell.at,unadjusted_book:{bid:'32.9',ask:'33.1'}};
 const r=tradeAttribution([buy,sell]),e=r.closed[0]!;assert.equal(e.reference_gross_pnl,'300');assert.equal(e.spread_cost,'20');
 assert.equal(e.modeled_price_impact,'20');assert.equal(e.execution_shortfall,'40');assert.equal(e.net_pnl,'210');assert.equal(r.reconciled,true);
});
test('open inventory never becomes a completed winner, invalid/duplicate fills never silently reconcile',()=>{
 const buy=fill('a','BUY',100,'30','20','0',null);assert.equal(tradeAttribution([buy]).closed.length,0);
 assert.equal(tradeAttribution([buy]).open[0]!.gross_pnl,'UNMARKED');
 assert.throws(()=>tradeAttribution([buy,buy]),/ATTRIBUTION_INVALID_FILL/);
 assert.throws(()=>tradeAttribution([fill('b','SELL',1,'30','20','0','0')]),/UNDERFLOW/);
});
