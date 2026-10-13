import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {largestStockScanner} from '../broker/scanner.js';
import type {ShioajiHttpBroker} from '../broker/http.js';
import {d} from './models.js';

const number=z.string().regex(/^\d+(?:\.\d+)?$/);
const cachedSchema=z.strictObject({version:z.literal(1),date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),rows:z.array(z.strictObject({
  code:z.string().regex(/^[1-9]\d{3}$/),name:z.string(),close:number.refine(v=>d(v).gt(0)),total_amount:number,date:z.string().optional(),
})).min(1).max(200).refine(rows=>new Set(rows.map(r=>r.code)).size===rows.length)});
let nextRankRequest=0;
/** Immutable past-date ranks; never substitute current ranking after a failed fetch. */
export async function cachedUniverse(broker:ShioajiHttpBroker,root:string,date:string,signal:AbortSignal){
  signal.throwIfAborted();await mkdir(root,{recursive:true,mode:0o700});
  const path=join(root,`universe-v1-${date}.json`);
  try{const saved=cachedSchema.parse(JSON.parse(await readFile(path,'utf8')));
    if(saved.date===date&&saved.rows.every(r=>r.date===undefined||r.date===date))return saved.rows;
  }catch{/* Invalid or absent caches are fetched again. */}
  const slot=Math.max(Date.now(),nextRankRequest);nextRankRequest=slot+250;
  if(slot>Date.now())await delay(slot-Date.now(),undefined,{signal});signal.throwIfAborted();
  const rows=await largestStockScanner(broker,'AmountRank',date,200);signal.throwIfAborted();
  if(!rows.length)throw new Error(`回測無法取得 ${date} 歷史股票排行；不使用今日排行替代`);
  const saved=cachedSchema.parse({version:1,date,rows}),temp=path+'.'+randomUUID()+'.tmp';
  await writeFile(temp,JSON.stringify(saved),{mode:0o600});await rename(temp,path);return saved.rows;
}
