import {test} from 'node:test';
import assert from 'node:assert/strict';
import {breakEvenExitPrice} from '../src/core/execution-economics.js';
import {roundTripEstimate} from '../src/core/costs.js';
import {SettingsSchema,d} from '../src/core/models.js';
import {alignedPrice} from '../src/core/risk.js';

test('estimated break-even covers all modeled costs and returns the first legal tick, including price-band changes',()=>{
  const s=SettingsSchema.parse({});
  for(const buy of ['9.99','49.95','99.9','499.5','999','1000'])for(const shares of [1,100,999,1000]){
    const ceiling=d(buy).times('1.1').toFixed(),p=breakEvenExitPrice(shares,buy,ceiling,s);
    if(!p)continue;
    assert.ok(alignedPrice(p));assert.ok(d(p).lte(ceiling));
    assert.ok(d(roundTripEstimate(shares,buy,p,s).estimated_net_target_gain!).gte(0));
    // Brute-force independent legal ticks from entry to the returned threshold.
    for(let cents=Math.ceil(Number(buy)*100);cents<Math.round(Number(p)*100);cents++){
      const earlier=d(cents).div(100).toFixed();if(alignedPrice(earlier))assert.ok(d(roundTripEstimate(shares,buy,earlier,s).estimated_net_target_gain!).lt(0));
    }
  }
});
test('small trades cannot invent a profitable exit inside the limit and a different size changes break-even',()=>{
  const s=SettingsSchema.parse({});assert.equal(breakEvenExitPrice(1,'30.05','33',s),null);
  const small=breakEvenExitPrice(100,'30.05','33',s),large=breakEvenExitPrice(1000,'30.05','33',s);
  assert.ok(small&&large&&d(small).gt(large));assert.equal(breakEvenExitPrice(0,'30.05','33',s),null);
  assert.equal(breakEvenExitPrice(100,'30.05','29',s),null);
});
