import type {Order,Settings} from './models.js';
// Exact decimal arithmetic with BigInt, usable by Node and the sandboxed browser.
// This module intentionally has no runtime package imports or broker capability.
type Money={units:bigint;scale:number};
const zero:Money={units:0n,scale:0},power=(n:number)=>10n**BigInt(n);
function parse(value:string):Money {
 if(!/^\d+(?:\.\d+)?$/.test(value))throw new Error('INVALID_RESERVATION_DECIMAL');
 const [whole,fraction='']=value.split('.');return {units:BigInt(whole!+fraction),scale:fraction.length};
}
function add(a:Money,b:Money,sign=1n):Money {const scale=Math.max(a.scale,b.scale);return {units:a.units*power(scale-a.scale)+sign*b.units*power(scale-b.scale),scale};}
const max=(a:Money,b:Money)=>add(a,b,-1n).units>=0n?a:b;
function format(a:Money):string {if(!a.scale)return a.units.toString();const text=a.units.toString().padStart(a.scale+1,'0');return (text.slice(0,-a.scale)+'.'+text.slice(-a.scale)).replace(/0+$/,'').replace(/\.$/,'');}
export function remainingBuyReservation(order:Pick<Order,'shares'|'filled'|'limit_price'>,s:Pick<Settings,'minimum_fee'|'fee_rate'>):string {
 const left=order.shares-order.filled;if(left<=0)return '0';
 if(!Number.isSafeInteger(order.shares)||!Number.isSafeInteger(order.filled)||order.filled<0)throw new Error('INVALID_RESERVATION_QUANTITY');
 const price=parse(order.limit_price),rate=parse(s.fee_rate),minimum=parse(s.minimum_fee);
 const principal=(shares:number):Money=>({units:price.units*BigInt(shares),scale:price.scale});
 const fee=(amount:Money):Money=>{const denominator=power(amount.scale+rate.scale),units=amount.units*rate.units;return max(minimum,{units:(units+denominator-1n)/denominator,scale:0});};
 // Any partial fill already paid at least the minimum; do not charge it twice.
 const extra=order.filled>0?max(zero,add(fee(principal(order.shares)),minimum,-1n)):fee(principal(left));
 return format(add(principal(left),extra));
}
export function reservedBuyCash(orders:Order[],s:Pick<Settings,'minimum_fee'|'fee_rate'>):string {
 return format(orders.filter(o=>o.action==='BUY'&&!['FILLED','CANCELLED','REJECTED'].includes(o.status))
  .reduce((sum,o)=>add(sum,parse(remainingBuyReservation(o,s))),zero));
}
