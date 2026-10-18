import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/core/store.js';
import { TradingCalendar, parseCalendar } from '../src/core/calendar.js';
import { Risk, alignedPrice, fee } from '../src/core/risk.js';
import { evaluate, updateProtection } from '../src/core/smart.js';
import { AnalysisSchema, OrderSchema, QuoteSchema, SettingsSchema, d, equity } from '../src/core/models.js';
import { indicators, validateAnalysis, demoAnalysis } from '../src/core/strategy.js';
import { csvRows } from '../src/core/facts.js';
import { now, settings, quote, instrument, account, order, snapshot } from './helpers.js';
function risk() { const store = new Store(':memory:'), calendar = new TradingCalendar(store); return {store,risk:new Risk(settings(),calendar)}; }
test('strict model validation rejects NaN, extra fields, timezone-free timestamps and overfills',() => {
  assert.throws(() => QuoteSchema.parse({...quote(),last:'NaN'}));
  assert.throws(() => QuoteSchema.parse({...quote(),trade_at:'2026-10-08T10:00:00'}));
  assert.throws(() => OrderSchema.parse({...order(),filled:31}));
  assert.throws(() => SettingsSchema.parse({api_key:'never-store'}));
  assert.throws(() => SettingsSchema.parse({min_cash_fraction:'0.5',max_exposure_fraction:'0.75'}));
});
test('decimal money and cash net of settlements do not use binary arithmetic',() => {
  assert.equal(d('.1').plus('.2').toFixed(),'0.3');
  assert.equal(equity({...account(),settlement_debits:'1000',settlement_credits:'500'}).toFixed(),'99500');
  assert.equal(fee('100',settings()).toFixed(),'20');
});
test('stock tick boundaries',() => {
  for (const p of ['9.99','10','10.05','49.95','50','50.1','100','100.5','500','501','1000','1005']) assert.ok(alignedPrice(p),p);
  for (const p of ['10.01','50.05','100.1','500.5','1001']) assert.ok(!alignedPrice(p),p);
});
test('calendar blocks holidays, unknown years and close; applies odd-lot effective date',() => {
  const store = new Store(':memory:'), calendar = new TradingCalendar(store);
  assert.ok(calendar.inSession(now));
  assert.ok(!calendar.inSession(new Date('2026-10-09T10:00:00+08:00')));
  assert.ok(!calendar.inSession(new Date('2027-01-05T10:00:00+08:00')));
  assert.ok(!calendar.inSession(new Date('2026-10-08T09:05:00+08:00')));
  assert.ok(calendar.inSession(new Date('2026-12-07T09:05:00+08:00')));
  assert.ok(!calendar.inSession(new Date('2026-10-08T13:30:00+08:00')));
  assert.equal(calendar.next('2026-10-08'),'2026-10-12'); store.close();
});
test('official calendar parser preserves named trading start/end dates',() => {
  const data = [['2026-01-01','休市',''],['2026-02-11','最後交易日',''],['2026-02-12','休市',''],
    ['2026-02-13','休市',''],['2026-02-16','休市',''],['2026-02-17','休市',''],['2026-02-18','休市',''],['2026-02-23','開始交易日','']];
  const result = parseCalendar({stat:'ok',title:'115 年',fields:['日期','名稱','說明'],data},2026,'official');
  assert.equal(result.length,365); assert.ok(result.find(r => r.day === '2026-02-11')!.open);
  assert.ok(!result.find(r => r.day === '2026-02-12')!.open);
  assert.throws(() => parseCalendar({stat:'ok'},2026,'official'));
});
test('small odd-lot buy passes all hard limits',() => {
  const r = risk(); assert.deepEqual(r.risk.check(order(),account(),quote(),instrument(),now,'100000'),[]); r.store.close();
});
test('cash limits include settlement debits and active buy reservations',() => {
  const r = risk(), a = {...account(),settlement_debits:'76000',
    positions:[{symbol:'9003',shares:2000,sellable:2000,average_price:'30',last_price:'30'}],
    orders:[order({local_id:'other',symbol:'9002',status:'PENDING',shares:100,limit_price:'30'})]};
  assert.ok(r.risk.check(order(),a,quote(),instrument(),now,'100000').some(x => x.includes('現金保留'))); r.store.close();
});
test('unknown order, stale book, simulated quotes and same-symbol reservations block',() => {
  const r = risk();
  assert.ok(r.risk.check(order(),{...account(),orders:[order({local_id:'other',status:'UNKNOWN'})]},quote(),instrument(),now,'100000').includes('存在尚未核對的委託'));
  assert.ok(r.risk.check(order(),account(),{...quote(),book_at:'2026-10-08T01:00:00Z'},instrument(),now,'100000').includes('成交或五檔行情過期'));
  assert.ok(r.risk.check(order(),account(),{...quote(),simulated:true},instrument(),now,'100000').length > 0); r.store.close();
});
test('daily loss freezes buys but allows selling old inventory',() => {
  const r = risk(), a = {...account(),cash:'97000',positions:[{symbol:'9001',shares:100,sellable:100,average_price:'30',last_price:'30'}]};
  assert.ok(r.risk.check(order(),a,quote(),instrument(),now,'105000').some(x => x.includes('日損失')));
  assert.deepEqual(r.risk.check(order({action:'SELL',purpose:'PROTECTION'}),a,quote(),instrument(),now,'105000'),[]); r.store.close();
});
test('today inventory, oversize odd orders, disabled whole lots and unsupported stocks are blocked',() => {
  const r = risk(), a = {...account(),positions:[{symbol:'9001',shares:100,sellable:0,average_price:'30',last_price:'30'}]};
  assert.ok(r.risk.check(order({action:'SELL'}),a,quote(),instrument(),now,'100000').some(x => x.includes('當沖')));
  assert.ok(r.risk.check(order({shares:1000}),account(),quote(),instrument(),now,'100000').some(x => x.includes('1–999')));
  assert.ok(r.risk.check(order({shares:1000,lot:'COMMON'}),account(),{...quote(),odd:false},instrument(),now,'100000').some(x => x.includes('整股')));
  assert.ok(r.risk.check(order(),account(),quote(),{...instrument(),kind:'ETF'},now,'100000').some(x => x.includes('普通股票'))); r.store.close();
});
test('protection cannot loosen stop or disable an activated trailing stop',() => {
  let p = updateProtection(undefined,'9001',{stop_price:'29',take_profit:'40',trailing_activate:'33',trailing_fraction:'0.03'},'a');
  assert.equal(evaluate(p,'34'),''); assert.equal(evaluate(p,'32'),'TRAILING');
  p = updateProtection(p,'9001',{stop_price:'28',take_profit:'40',trailing_activate:null,trailing_fraction:null},'b');
  assert.equal(p.spec.stop_price,'29'); assert.equal(p.spec.trailing_activate,'33'); assert.equal(p.high_water,'34');
  assert.equal(evaluate(p,'28'),'STOP'); assert.equal(evaluate(p,'34'),'');
});
test('analysis checks snapshot identity, expiry, available candidates, history and review mode',() => {
  const input = snapshot(), s = settings(), a = demoAnalysis(input,s,now);
  assert.ok(validateAnalysis(a,input,now,s).id);
  assert.throws(() => validateAnalysis({...a,snapshot_id:'wrong'},input,now,s));
  assert.ok(validateAnalysis({...a,candidates:['9001']},input,now,s).id);
  assert.throws(() => validateAnalysis({...a,candidates:[]},input,now,s));
  assert.throws(() => validateAnalysis({...a,expires_at:now.toISOString()},input,now,s));
  assert.throws(() => validateAnalysis(a,{...input,review_only:true},now,s));
  input.features['9001']!.sufficient=false; assert.throws(() => validateAnalysis(a,input,now,s));
  assert.throws(() => AnalysisSchema.parse({...a,stance:'HOLD_ONLY'}));
});
test('daily indicators use completed bars and handle flat prices',() => {
  const bars = Array.from({length:60},(_,i) => ({date:new Date(Date.UTC(2026,7,i+1)).toISOString().slice(0,10),close:30,high:31,low:29,volume:100}));
  const f = indicators(bars); assert.equal(f.ma60,30); assert.equal(f.rsi14,50); assert.equal(f.atr14,2);
  assert.equal(f.volume_ratio20,1); assert.equal(indicators(bars.slice(0,10)).sufficient,false);
});
test('CSV parser handles quoted commas, escaped quotes and embedded lines',() => {
  assert.deepEqual(csvRows('公司代號,主旨\r\n9001,"a,b"\r\n9002,"a""b\nc"\r\n'),[
    {'公司代號':'9001','主旨':'a,b'},{'公司代號':'9002','主旨':'a"b\nc'}]);
});
test('SQLite persists intents/protection atomically and locks out a second process',() => {
  const dir = mkdtempSync(join(tmpdir(),'shioaji-store-')), path = join(dir,'demo.db');
  const store = new Store(path); assert.ok(store.insertIntent(order())); assert.ok(!store.insertIntent(order()));
  assert.ok(!store.insertIntent(order({local_id:'duplicate-tag'}))); assert.throws(() => new Store(path),/執行中的程式/);
  const p = updateProtection(undefined,'9001',{stop_price:'29',take_profit:null,trailing_activate:null,trailing_fraction:null},'plan');
  const input = snapshot(), a = demoAnalysis(input,settings(),now), plan = validateAnalysis(a,input,now,settings());
  store.activatePlan(plan,[p]); store.close();
  const reopened = new Store(path); assert.equal(reopened.orders().length,1); assert.equal(reopened.plan()!.id,plan.id);
  assert.equal(reopened.protections()[0]!.spec.stop_price,'29'); reopened.close(); rmSync(dir,{recursive:true,force:true});
});
