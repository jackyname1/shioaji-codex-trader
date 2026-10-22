import {createHash} from 'node:crypto';
import type {HistoryDataset} from './backtest-data.js';
/** Content identity, separate from the controller's storage UUID. No giant JSON copy. */
export function datasetIdentity(dataset:HistoryDataset):string {
  const hash=createHash('sha256');
  const canonical=(value:unknown):string=>value===null||typeof value!=='object'?JSON.stringify(value)??'null'
    :Array.isArray(value)?'['+value.map(canonical).join(',')+']'
    :'{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b))
      .map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  const {points,daily_history,...metadata}=dataset;
  hash.update(canonical(metadata)+'\npoints\n');
  for(const p of points)hash.update(canonical(p)+'\n');
  hash.update('daily_history\n');for(const p of daily_history??[])hash.update(canonical(p)+'\n');
  return hash.digest('hex');
}
