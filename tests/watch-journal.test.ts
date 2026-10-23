import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/core/store.js';
import type {WatchChange} from '../src/core/watchlist.js';
test('watch audit retains all changes beyond the 120-row display ring without duplicate samples',()=>{
 const store=new Store(':memory:');try{
  const rows=Array.from({length:350},(_,i)=>({at:new Date(Date.UTC(2026,9,8,1,i)).toISOString(),symbol:'9001',action:i%2?'REMOVE':'ADD',reason:'test'} as WatchChange));
  store.recordWatchChanges(rows);store.recordWatchChanges(rows.slice(-120));
  assert.deepEqual(store.watchChanges(),rows);assert.equal(store.watchChanges().length,350);
 }finally{store.close();}
});
