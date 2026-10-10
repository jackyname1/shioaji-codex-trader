import { AnalysisSchema, d, type Analysis, type Settings, type Snapshot } from './models.js';

/** A deterministic baseline for fast estimates, using only the time-limited snapshot. */
export function programAnalysis(snapshot: Snapshot, settings: Settings): Analysis {
  const candidates = snapshot.universe.filter(c => snapshot.features[c.symbol]?.sufficient)
    .slice(0, settings.watch_max_symbols).map(c => c.symbol);
  return AnalysisSchema.parse({ snapshot_id: snapshot.snapshot_id,
    expires_at: new Date(Date.parse(snapshot.asof) + settings.plan_max_minutes * 60000).toISOString(),
    stance: snapshot.review_only || !candidates.length ? 'HOLD_ONLY' : 'BUY_ALLOWED', candidates, decisions: [],
    summary: snapshot.review_only ? '程式策略完成盤後核對。' : '快速程式策略：MA5 ≥ MA20、價格 ≥ MA20，依量能與 RSI 篩選；所有委託沿用帳戶風控。',
    screening: { min_amount: settings.watch_min_amount, min_volume_ratio: '0.7', rsi_min: 30, rsi_max: 75, return20_min: '-0.05',
      entry: snapshot.review_only ? null : { signal: 'TREND', allocation_fraction: d(settings.max_order_fraction).lt('.05')?settings.max_order_fraction:'0.05', max_ma20_distance: '0.05',
        stop_fraction: '0.05', take_profit_fraction: '0.10', trailing_fraction: '0.03' } } });
}
