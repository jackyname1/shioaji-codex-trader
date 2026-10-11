import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { historicalKbars } from '../broker/historical-format.js';
import { type ShioajiHttpBroker } from '../broker/http.js';
import { addDays, twDay } from './models.js';
import { historyWindows, validateCachedPoints } from './chart.js';
import {normalizeHistoryPoints,type HistoryPoint} from './backtest-data.js';
import { BrokerError, brokerStageIssue } from '../broker/health.js';

let nextHistoryRequest=0;
export async function cachedHistory(broker: ShioajiHttpBroker, root: string | undefined, symbol: string, exchange: 'TSE' | 'OTC',
  start: string, end: string, cutoff: string, signal: AbortSignal, progress: (message: string) => void = () => undefined,
  onNormalization:(counts:{duplicates:number;revisions:number})=>void=()=>undefined): Promise<HistoryPoint[]> {
  if (root) await mkdir(root, { recursive: true, mode: 0o700 });
  const today = twDay(new Date()), pastEnd = end < today ? end : addDays(today, -1);
  const windows = start <= pastEnd ? historyWindows(start, pastEnd) : [];
  if (end >= today && start <= today) windows.push({ start: today, end: today });
  const result: HistoryPoint[] = [];
  for (const range of windows) {
    signal.throwIfAborted();
    // Market history belongs to the contract/date, never the app's automatically chosen local port.
    const key = createHash('sha256').update(JSON.stringify(['shioaji-1.7.7-minutes-v4', symbol, exchange, range])).digest('hex');
    const path = root ? join(root, key + '.json') : undefined;
    let batch: HistoryPoint[] | undefined;
    if (path && range.end < today) try {
      const normalized=normalizeHistoryPoints(validateCachedPoints(JSON.parse(await readFile(path, 'utf8'))),'latest'),cached=normalized.points;
      if (cached.length&&cached.every(p => p.symbol === symbol && twDay(new Date(p.at)) >= range.start && twDay(new Date(p.at)) <= range.end)) {batch = cached;onNormalization(normalized);}
    } catch { /* Invalid or absent cache is fetched once. */ }
    progress(`${symbol} · ${range.start} — ${range.end}${batch ? ' · 已快取' : ' · 下載中'}`);
    if (!batch) {
      const slot=Math.max(Date.now(),nextHistoryRequest);nextHistoryRequest=slot+250;
      if(slot>Date.now())await delay(slot-Date.now(),undefined,{signal});
      const retries=[2000,4000,8000];
      let raw:unknown;
      for(let attempt=0;;attempt++){
        signal.throwIfAborted();
        try {raw=await broker.request('/data/kbars',{contract:{security_type:'STK',region:'TW',exchange,code:symbol,target_code:null},...range},{timeoutMs:10000});break;}
        catch(error){if(!(error instanceof BrokerError)||!error.retryable||attempt>=retries.length)throw error;
          progress(`${symbol} · 歷史服務暫時忙碌，正在重試 ${attempt+1}/${retries.length}`);
          await delay(retries[attempt]!,undefined,{signal});}
      }
      try{const normalized=normalizeHistoryPoints(historicalKbars(raw,symbol),'latest');onNormalization(normalized);
        batch=normalized.points.filter(p => twDay(new Date(p.at)) >= range.start && twDay(new Date(p.at)) <= range.end);
        if(normalized.duplicates)progress(`${symbol} · 已整理 ${normalized.duplicates} 筆重複 K 線${normalized.revisions?`，採用 ${normalized.revisions} 筆服務端修訂`:''}`);}
      catch(error){throw brokerStageIssue('歷史 K 線',error);}
      // Never make today's partial data look like a complete immutable cache.
      // The immutable cache retains the full API window. A simulation's cutoff only filters its returned view.
      if (path && range.end < today && batch.length) {
        const temp = path + '.' + randomUUID() + '.tmp'; await writeFile(temp, JSON.stringify(batch), { mode: 0o600 }); await rename(temp, path);
      }
    }
    result.push(...batch.filter(p => Date.parse(p.at) <= Date.parse(cutoff)));
  }
  return normalizeHistoryPoints(result,'latest').points;
}
