import { z } from 'zod';
import { HistoryPointSchema, validDay, type HistoryPoint } from './backtest-data.js';
import { addDays, twDay } from './models.js';

export const ChartRequestSchema = z.strictObject({
  source: z.enum(['live', 'replay']), symbol: z.string().regex(/^[1-9]\d{3}$/),
  start: z.string().refine(validDay), end: z.string().refine(validDay),
  interval: z.enum(['1m', '5m', '15m', '60m', '1d']).default('1d'),
}).refine(x => x.start <= x.end && Date.parse(x.end) - Date.parse(x.start) <= 5 * 366 * 86400000, '圖表日期區間不合法');
export type ChartRequest = z.infer<typeof ChartRequestSchema>;
export interface ChartBar { at: string; open: number; high: number; low: number; close: number; volume: number;
  ma5?: number; ma20?: number; ma60?: number; upper?: number; lower?: number; rsi?: number }
export interface ChartData { symbol: string; name: string; interval: ChartRequest['interval']; asof: string;
  bars: ChartBar[]; total_points: number; source: string; issue: string }

export function historyWindows(start: string, end: string): { start: string; end: string }[] {
  if (!validDay(start) || !validDay(end) || start > end) throw new Error('歷史日期不合法');
  const windows = [];
  for (let from = start; from <= end; from = addDays(from, 30))
    windows.push({ start: from, end: addDays(from, 29) < end ? addDays(from, 29) : end });
  return windows;
}
/** Only closed bars at or before the supplied server-owned cutoff enter indicators. */
export function buildChart(points: HistoryPoint[], request: ChartRequest, cutoff: string, name = request.symbol, source = 'Shioaji'): ChartData {
  const end = Math.min(Date.parse(cutoff), Date.parse(request.end + 'T23:59:59.999+08:00'));
  const known = points.filter(p => p.symbol === request.symbol && Date.parse(p.at) <= end).sort((a, b) => a.at.localeCompare(b.at));
  const groups = new Map<string, ChartBar>();
  const minutes = request.interval === '1d' ? 1440 : Number(request.interval.slice(0, -1));
  for (const p of known) {
    const date = new Date(p.at), day = twDay(date), stamp = Date.parse(p.at);
    // Minute bars are timestamped at their closing time. Preserve end-of-bucket time.
    const key = request.interval === '1d' ? day : String(Math.ceil(stamp / (minutes * 60000)) * minutes * 60000);
    const old = groups.get(key);
    groups.set(key, { at: p.at, open: old?.open ?? Number(p.open), high: Math.max(old?.high ?? -Infinity, Number(p.high)),
      low: Math.min(old?.low ?? Infinity, Number(p.low)), close: Number(p.close), volume: (old?.volume ?? 0) + p.volume_shares });
  }
  const bars = [...groups.values()];
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!;
    for (const n of [5, 20, 60] as const) if (i + 1 >= n)
      bar[`ma${n}`] = bars.slice(i + 1 - n, i + 1).reduce((s, b) => s + b.close, 0) / n;
    if (bar.ma20 !== undefined) {
      const sd = Math.sqrt(bars.slice(i - 19, i + 1).reduce((s, b) => s + (b.close - bar.ma20!) ** 2, 0) / 20);
      bar.upper = bar.ma20 + 2 * sd; bar.lower = bar.ma20 - 2 * sd;
    }
    if (i >= 14) {
      let gain = 0, loss = 0;
      for (let j = i - 13; j <= i; j++) { const change = bars[j]!.close - bars[j - 1]!.close; gain += Math.max(change, 0); loss += Math.max(-change, 0); }
      bar.rsi = !loss ? (!gain ? 50 : 100) : 100 - 100 / (1 + gain / loss);
    }
  }
  return { symbol: request.symbol, name, interval: request.interval, asof: new Date(end).toISOString(),
    bars: bars.filter(b => twDay(new Date(b.at)) >= request.start), total_points: known.filter(p => twDay(new Date(p.at)) >= request.start).length,
    source, issue: known.length ? '' : '選定範圍沒有已知行情' };
}
export function validateCachedPoints(raw: unknown): HistoryPoint[] { return z.array(HistoryPointSchema).parse(raw); }
