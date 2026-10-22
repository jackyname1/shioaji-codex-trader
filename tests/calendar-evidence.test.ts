import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TradingCalendar,applyCalendarExceptions} from '../src/core/calendar.js';
import {Store} from '../src/core/store.js';
import {addDays} from '../src/core/models.js';
test('dated 2023 typhoon evidence corrects the annual schedule only after its conservative visibility boundary',()=>{
 const store=new Store(':memory:'),calendar=new TradingCalendar(store);try{
  const days=[];for(let day='2023-07-31';day<'2023-08-10';day=addDays(day,1))days.push({day,open:![0,6].includes(new Date(day+'T00:00:00Z').getUTCDay()),source:'annual fixture',verified_at:'2023-01-01T00:00:00Z'});
  store.saveSessions(applyCalendarExceptions(days));
  calendar.setAsOf(new Date('2023-08-02T10:00:00+08:00'));assert.equal(calendar.isOpen('2023-08-03'),true);
  assert.equal(calendar.nextSettlement(calendar.nextSettlement('2023-08-02')),'2023-08-04');
  calendar.setAsOf(new Date('2023-08-03T00:00:00+08:00'));assert.equal(calendar.isOpen('2023-08-03'),false);
  assert.equal(calendar.nextSettlement(calendar.nextSettlement('2023-08-02')),'2023-08-07');
  assert.match(store.session('2023-08-03')!.source,/be0109d1/);assert.equal(store.session('2023-08-03')!.settlement_open,false);
  // A second annual refresh cannot erase the dated evidence.
  store.saveSessions(applyCalendarExceptions(days));assert.equal(calendar.isOpen('2023-08-03'),false);
 }finally{store.close();}
});
