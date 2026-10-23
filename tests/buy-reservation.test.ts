import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {remainingBuyReservation,reservedBuyCash} from '../src/core/buy-reservation.js';
import {fee} from '../src/core/costs.js';
import {d} from '../src/core/models.js';
import {order,settings} from './helpers.js';
test('shared renderer/core reservation is exact at tick and fee rounding boundaries and aggregates all active intents',()=>{
 const s=settings();
 for(const price of ['0.01','9.99','30.05','100.5','99999.995'])for(const shares of [1,30,999,10000])for(const filled of [0,Math.floor(shares/2),shares]){
  const o=order({shares,filled,limit_price:price}),principal=d(price).times(shares-filled);
  const extra=filled?d(fee(d(price).times(shares),s)).minus(s.minimum_fee).clamp(0,Infinity):fee(principal,s);
  const expected=filled===shares?'0':principal.plus(extra).toFixed();assert.equal(remainingBuyReservation(o,s),expected);
 }
 const partial=order({shares:100,filled:20,limit_price:'100',status:'PARTIAL'}),uncertain=order({local_id:'other',shares:1,filled:0,limit_price:'0.01',status:'UNKNOWN'});
 assert.equal(reservedBuyCash([partial,uncertain,{...partial,action:'SELL'},{...partial,status:'CANCELLED'}],s),'8020.01');
});
test('browser reservation module imports no executable Node or package dependency',()=>{
 const js=readFileSync(new URL('../src/core/buy-reservation.js',import.meta.url),'utf8');
 assert.ok(!/^import\s/m.test(js));assert.equal(remainingBuyReservation(order({shares:100,filled:20,limit_price:'100'}),settings()),'8000');
});
