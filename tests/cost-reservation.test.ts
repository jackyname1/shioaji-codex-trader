import {test} from 'node:test';
import assert from 'node:assert/strict';
import {remainingBuyCost,entryQualityIssues,entryRiskIssues,fee} from '../src/core/costs.js';
import {authorizedRisk} from '../src/core/risk-policy.js';
import {d,SettingsSchema} from '../src/core/models.js';
import {order,settings,account} from './helpers.js';

test('partial fill reservation never charges another minimum fee and remains a conservative cash bound',()=>{
 const s=settings();
 assert.equal(remainingBuyCost(order({shares:100,filled:0,limit_price:'100'}),s).toFixed(),'10020');
 assert.equal(remainingBuyCost(order({shares:100,filled:20,limit_price:'100'}),s).toFixed(),'8000');
 for(const shares of [10,100,1000,10000])for(const filled of [0,1,Math.floor(shares/2),shares]){
   const o=order({shares,filled,limit_price:'100'}),reserved=remainingBuyCost(o,s);
   const prior=d(filled).times('99'),final=prior.plus(d(shares-filled).times(100));
   const actualRemaining=d(shares-filled).times(100).plus(filled?fee(final,s).minus(fee(prior,s)):fee(final,s));
   assert.ok(reserved.gte(actualRemaining),JSON.stringify({shares,filled}));
 }
});
test('zero reward-risk setting cannot bypass negative net economics or invalid protection',()=>{
 const s=SettingsSchema.parse({...settings(),min_entry_reward_risk:'0',min_net_profit_twd:'0'});
 assert.ok(entryQualityIssues(10,'30',{stop_price:'29',take_profit:'33',trailing_activate:null,trailing_fraction:null},s).length);
 assert.ok(entryQualityIssues(100,'30',undefined,s).length);
 assert.deepEqual(entryQualityIssues(100,'30',{stop_price:'29',take_profit:'35',trailing_activate:null,trailing_fraction:null},s),[]);
});
test('one percent risk ceiling cannot be disabled by old profiles; stricter limits remain intact',()=>{
 assert.equal(SettingsSchema.parse({}).max_trade_risk_fraction,'0.01');assert.equal(SettingsSchema.parse({}).min_entry_reward_risk,'1.2');
 for(const value of ['0','0.02','1'])assert.equal(authorizedRisk(SettingsSchema.parse({max_trade_risk_fraction:value})).max_trade_risk_fraction,'0.01');
 assert.equal(authorizedRisk(SettingsSchema.parse({max_trade_risk_fraction:'0.005'})).max_trade_risk_fraction,'0.005');
 const s=authorizedRisk(SettingsSchema.parse({max_trade_risk_fraction:'0'}));
 assert.ok(entryRiskIssues(1000,'30',{stop_price:'20',take_profit:'50',trailing_activate:null,trailing_fraction:null},account(),s).length);
});
test('cost coverage research is stricter, off by default and forbidden in live profiles',()=>{
 const smart={stop_price:'29',take_profit:'31',trailing_activate:null,trailing_fraction:null};
 const s=SettingsSchema.parse({min_entry_reward_risk:'0',min_net_profit_twd:'0'});
 assert.equal(s.research_cost_aware,false);assert.deepEqual(entryQualityIssues(100,'30',smart,s),[]);
 assert.ok(entryQualityIssues(100,'30',smart,{...s,research_cost_aware:true}).some(i=>i.includes('兩倍')));
 assert.equal(SettingsSchema.safeParse({...s,mode:'live',research_cost_aware:true}).success,false);
});
