import { z } from 'zod';
import { ShioajiHttpBroker } from '../broker/http.js';
import { Store } from './store.js';
import { SettingsSchema, addDays, twDay, type Settings } from './models.js';
import { buildChart, ChartRequestSchema, type ChartData } from './chart.js';
import { cachedHistory } from './history-cache.js';

export async function liveChart(raw: unknown, settings: Settings, cacheRoot: string, signal: AbortSignal): Promise<ChartData> {
  const request = ChartRequestSchema.parse(raw), cutoff = new Date().toISOString();
  if (request.end > twDay(new Date(cutoff))) throw new Error('圖表結束日不能晚於現在');
  const store = new Store(':memory:'), broker = new ShioajiHttpBroker(store, SettingsSchema.parse({ ...settings, mode: 'readonly' }));
  const abort = (): void => { void broker.close(); }; signal.addEventListener('abort', abort, { once: true });
  try {
    const info = z.object({ simulation: z.literal(false) }).parse(await broker.request('/info'));
    if (info.simulation !== false) throw new Error('圖表需要 Shioaji 真實行情');
    const meta = z.object({ security_type: z.literal('STK'), exchange: z.enum(['TSE', 'OTC']), name: z.string() })
      .parse(await broker.request(`/data/contracts/${request.symbol}/info?region=TW&security_type=STK`));
    const start = addDays(request.start, request.interval === '1d' ? -150 : -10);
    const points = await cachedHistory(broker, cacheRoot, request.symbol, meta.exchange, start < '2020-03-02' ? '2020-03-02' : start,
      request.end, cutoff, signal);
    return buildChart(points, request, cutoff, meta.name, 'Shioaji 真實分鐘 K 線');
  } finally { signal.removeEventListener('abort', abort); await broker.close(); store.close(); }
}
