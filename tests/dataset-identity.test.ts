import {test} from 'node:test';
import assert from 'node:assert/strict';
import {datasetIdentity} from '../src/core/dataset-identity.js';
import {syntheticDataset,validateDataset} from '../src/core/backtest-data.js';
test('dataset content identity survives key order but changes with prices, dates, universe or calendar',()=>{
 const dataset=validateDataset(syntheticDataset('2026-10-08','2026-10-08')),hash=datasetIdentity(dataset);
 const reordered=Object.fromEntries(Object.entries(dataset).reverse());assert.equal(datasetIdentity(reordered as typeof dataset),hash);
 for(const mutate of [(x:typeof dataset)=>{x.points[0]!.volume_shares++;},(x:typeof dataset)=>{x.source+=' changed';},
   (x:typeof dataset)=>{x.daily_universe={'2026-10-08':{asof:'2026-10-07',symbols:['9001']}};}]){
  const copy=structuredClone(dataset);mutate(copy);assert.notEqual(datasetIdentity(copy),hash);
 }
});
