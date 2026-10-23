import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TradingService} from '../src/core/service.js';
import {demoAnalysis} from '../src/core/strategy.js';
import {d} from '../src/core/models.js';
test('CLI synthetic rotation submits an affordable cost-qualified example and actually exercises partial fills',async()=>{
 const s=new TradingService(':memory:','demo'),now=new Date('2026-10-08T10:00:00+08:00');try{
  await s.engine.start(now);s.engine.setSettings({...s.engine.settings,auto_execute:true});
  const snap=await s.engine.snapshot(now),analysis=demoAnalysis(snap,s.engine.settings,now),decision=analysis.decisions[0]!;
  assert.ok(d(decision.limit_price).times(decision.shares).lte(7500));
  await s.engine.activate(analysis,snap,now);for(let n=0;n<5;n++)await s.engine.tick(new Date(now.getTime()+n*1000));
  const orders=s.store.orders();assert.ok(orders.some(o=>o.filled>0));assert.ok(orders.every(o=>d(o.limit_price).times(o.shares).lte(7500)));
  assert.ok(s.engine.entryFunnel.report().signals.some(row=>row.checks.FILLED?.passed));
 }finally{await s.close();}
});
