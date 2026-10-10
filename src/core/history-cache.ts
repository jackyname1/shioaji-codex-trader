import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { historicalKbars } from '../broker/historical-format.js';
import { type ShioajiHttpBroker } from '../broker/http.js';
import { addDays, twDay } from './models.js';
import { historyWindows, validateCachedPoints } from './chart.js';
import type { HistoryPoint } from './backtest-data.js';

let nextHistoryRequest=0;
export async function cachedHistory(broker: ShioajiHttpBroker, root: string | undefined, symbol: string, exchange: 'TSE' | 'OTC',
  start: string, end: string, cutoff: string, signal: AbortSignal, progress: (message: string) => void = () => undefined): Promise<HistoryPoint[]> {
  if (root) await mkdir(root, { recursive: true, mode: 0o700 });
  const today = twDay(new Date()), pastEnd = end < today ? end : addDays(today, -1);
  const windows = start <= pastEnd ? historyWindows(start, pastEnd) : [];
  if (end >= today && start <= today) windows.push({ start: today, end: today });
  const result: HistoryPoint[] = [];
  for (const range of windows) {
    signal.throwIfAborted();
    const key = createHash('sha256').update(JSON.stringify([broker.settings.base_url, symbol, exchange, range, 'minutes-v3'])).digest('hex');
    const path = root ? join(root, key + '.json') : undefined;
    let batch: HistoryPoint[] | undefined;
    if (path && range.end < today) try {
      const cached = validateCachedPoints(JSON.parse(await readFile(path, 'utf8')));
      if (cached.every(p => p.symbol === symbol && twDay(new Date(p.at)) >= range.start && twDay(new Date(p.at)) <= range.end)) batch = cached;
    } catch { /* Invalid or absent cache is fetched once. */ }
    progress(`${symbol} · ${range.start} — ${range.end}${batch ? ' · 已快取' : ' · 下載中'}`);
    if (!batch) {
      const slot=Math.max(Date.now(),nextHistoryRequest);nextHistoryRequest=slot+250;
      if(slot>Date.now())await delay(slot-Date.now(),undefined,{signal});
      batch = historicalKbars(await broker.request('/data/kbars', { contract: { security_type: 'STK', exchange, code: symbol }, ...range }), symbol)
        .filter(p => twDay(new Date(p.at)) >= range.start && twDay(new Date(p.at)) <= range.end);
      // Never make today's partial data look like a complete immutable cache.
      // The immutable cache retains the full API window. A simulation's cutoff only filters its returned view.
      if (path && range.end < today) {
        const temp = path + '.' + randomUUID() + '.tmp'; await writeFile(temp, JSON.stringify(batch), { mode: 0o600 }); await rename(temp, path);
      }
    }
    result.push(...batch.filter(p => Date.parse(p.at) <= Date.parse(cutoff)));
  }
  return result;
}
