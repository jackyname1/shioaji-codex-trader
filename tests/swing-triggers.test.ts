import {test} from 'node:test';
import assert from 'node:assert/strict';
import {entryProtectionIssues,admissionIssues} from '../src/core/entry-policy.js';
import {Risk} from '../src/core/risk.js';
import {entryRiskIssues,entryQualityIssues} from '../src/core/costs.js';
import {updateProtection,evaluate} from '../src/core/smart.js';
import {Store} from '../src/core/store.js';
import {TradingCalendar} from '../src/core/calendar.js';
import {analysisPrompt} from '../src/core/codex.js';
import {account,instrument,now,order,quote,rig,settings,snapshot} from './helpers.js';

const spec={stop_price:'26',take_profit:'40',reward_target:'40',trailing_activate:null,trailing_fraction:null};
test('cross-session trigger prices do not inherit today’s order band; actual orders still do',()=>{
  const store=new Store(':memory:'),calendar=new TradingCalendar(store);try{
    assert.deepEqual(entryProtectionIssues('30.05',spec),[]);
    assert.deepEqual(admissionIssues(order(),account(),settings(),spec,{'9001':instrument()}, {},quote(),undefined,calendar,now),[]);
    const risk=new Risk(settings(),calendar);
    assert.deepEqual(risk.check(order(),account(),quote(),instrument(),now,'100000'),[]);
    for(const price of ['26','40'])assert.ok(risk.check(order({limit_price:price}),account(),quote(),instrument(),now,'100000').includes('價格超出已確認的漲跌停範圍'));
    assert.deepEqual(entryProtectionIssues('30.05',{...spec,stop_price:'27'}),[]);
    assert.ok(entryProtectionIssues('30.05',undefined).length);
    assert.ok(entryProtectionIssues('30.05',{...spec,stop_price:'0'}).length);
    assert.ok(entryProtectionIssues('30.05',{...spec,stop_price:'31'}).length);
  }finally{store.close();}
});
test('wide cross-session stops still consume fee-inclusive risk and target economics budgets',()=>{
  const s={...settings(),max_trade_risk_fraction:'0.01',min_entry_reward_risk:'1.2'};
  assert.deepEqual(entryRiskIssues(30,'30.05',spec,account(),s),[]);
  assert.ok(entryRiskIssues(300,'30.05',spec,account(),s).some(x=>x.includes('停損風險預算')));
  assert.ok(entryQualityIssues(30,'30.05',{...spec,take_profit:'31',reward_target:'31'},s).length);
  const p=updateProtection(undefined,'9001',spec,'fixture');
  assert.equal(evaluate(p,'30'),'');assert.equal(evaluate(p,'25'),'STOP');
  assert.equal(evaluate(updateProtection(undefined,'9001',spec,'fixture'),'41'),'TAKE_PROFIT');
});
test('deterministic entry reaches submission with a stop below today’s band and target above it',async()=>{
  const r=await rig();try{
    r.engine.setSettings({...r.s,codex_enabled:true,execution_sizing:'deterministic'});
    r.engine.plan!.analysis.decisions[0]!.smart={...spec};
    await r.engine.tick(now);
    assert.equal(r.store.orders().length,1,JSON.stringify([...r.engine.decisionStates]));
    assert.equal(r.store.orders()[0]!.shares,30);
    assert.equal(r.store.protections()[0]!.spec.stop_price,'26');
    assert.equal(r.store.protections()[0]!.spec.take_profit,'40');
  }finally{await r.engine.close();r.store.close();}
});
test('strategy prompt distinguishes future triggers from legal execution prices without inventing returns',()=>{
  const prompt=analysisPrompt(snapshot());assert.match(prompt,/不受今日漲跌停截斷/);
  assert.match(prompt,/不得為湊淨報酬風險比提高目標/);assert.match(prompt,/送單當日漲跌停/);
});
