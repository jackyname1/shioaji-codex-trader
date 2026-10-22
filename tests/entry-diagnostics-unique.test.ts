import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EntryDiagnosticTracker} from '../src/core/entry-diagnostics.js';
import {entryDiagnosticText} from '../src/core/entry-diagnostics-text.js';
import {demoAnalysis} from '../src/core/strategy.js';
import {now,settings,snapshot,order} from './helpers.js';

test('repeated monitor samples count a single entry signal per plan and symbol, excluding protection waits',()=>{
  const x=new EntryDiagnosticTracker(),input=snapshot(),a=demoAnalysis(input,settings(),now);
  x.strategy(a,input.features,{},now,'first');
  const states=new Map([
    ['9001',{state:'WAIT',reason:'費用不足',source:'CODEX'}],
    ['9002',{state:'WAIT',reason:'等待可賣庫存',source:'PROTECTION'}],
  ]);
  for(let i=0;i<100;i++)x.monitor(states);
  const r=x.report([]);assert.equal(r.monitor_samples,100);
  assert.equal(r.unique_entries!.signals,1);assert.equal(r.unique_entries!.blocked_signals,1);
  assert.deepEqual(r.unique_entries!.reason_categories,{COST:1});
  assert.equal(r.reason_categories!.COST,100);
  states.set('9001',{state:'BLOCKED',reason:'報酬風險不足',source:'CODEX'});x.monitor(states);
  assert.deepEqual(x.report([]).unique_entries!.reason_categories,{COST:1,REWARD_RISK:1});
  assert.match(entryDiagnosticText(x.report([])),/獨立進場訊號 1/);
  x.strategy(a,input.features,{},now,'second');x.monitor(states);
  assert.equal(x.report([]).unique_entries!.signals,2);
});
test('rule waits are deduplicated and cross-session ROD orders remain one signal',()=>{
  const x=new EntryDiagnosticTracker(),input=snapshot(),a=demoAnalysis(input,settings(),now);
  x.strategy({...a,decisions:[]},input.features,{},now,'rules');
  for(let i=0;i<100;i++)x.monitor(new Map([['9003',{state:'TRACKING',reason:'等待反彈',source:'RULE'}]]));
  const orders=[order({local_id:'one',plan_id:'rules',symbol:'9003',status:'CANCELLED'}),
    order({local_id:'two',plan_id:'rules',symbol:'9003',created_at:'2026-10-12T02:00:00Z'})];
  assert.equal(x.report(orders).buy_orders,2);assert.equal(x.report(orders).unique_entries!.signals,1);
  assert.equal(x.report(orders).unique_entries!.reason_categories.TRIGGER,1);
});
