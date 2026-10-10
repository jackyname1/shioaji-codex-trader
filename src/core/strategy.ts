import { randomUUID } from 'node:crypto';
import { AnalysisSchema, ageSeconds, d, type Analysis, type Bar, type Features, type Plan, type Settings, type Snapshot } from './models.js';
import { roundPrice, tickSize } from './risk.js';
const mean = (x: number[]): number => x.reduce((a, b) => a + b, 0) / x.length;
export function indicators(bars: Bar[]): Features {
  if (bars.length < 20 || bars.some(b => ![b.close,b.high,b.low,b.volume].every(Number.isFinite)
    || b.close <= 0 || b.high < b.low || b.volume < 0)) return { sufficient: false, sessions: bars.length };
  const closes = bars.map(b => b.close), last = bars.at(-1)!;
  const result: Features = { sufficient: true, sessions: bars.length, asof: last.date,
    daily_amount:d(last.close).times(last.volume).toFixed() };
  for (const n of [5,20,60] as const) if (closes.length >= n) result[`ma${n}`] = mean(closes.slice(-n));
  const changes = closes.slice(-14).map((c, i) => c - closes[closes.length - 15 + i]!);
  const up = mean(changes.map(c => Math.max(0, c))), down = mean(changes.map(c => Math.max(0, -c)));
  result.rsi14 = down ? 100 - 100 / (1 + up / down) : (up ? 100 : 50);
  result.atr14 = mean(bars.slice(-14).map((b, i) => Math.max(b.high - b.low,
    Math.abs(b.high - closes[closes.length - 15 + i]!), Math.abs(b.low - closes[closes.length - 15 + i]!))));
  result.support20 = Math.min(...bars.slice(-20).map(b => b.low));
  result.resistance20 = Math.max(...bars.slice(-20).map(b => b.high));
  const averageVolume = mean(bars.slice(-20).map(b => b.volume));
  result.volume_ratio20 = averageVolume ? last.volume / averageVolume : 0;
  result.return20 = last.close / closes.at(-20)! - 1;
  return result;
}
export function validateAnalysis(raw: unknown, snapshot: Snapshot, now: Date, settings: Settings): Plan {
  const a = AnalysisSchema.parse(raw);
  if (a.snapshot_id !== snapshot.snapshot_id) throw new Error('Codex 使用的快照不符');
  const age = ageSeconds(now, snapshot.asof);
  if (!(age >= 0 && age <= settings.codex_timeout_seconds + 30)) throw new Error('Codex 決策資料已過期');
  const expiry = Date.parse(a.expires_at);
  if (!(expiry > now.getTime() && expiry <= now.getTime() + settings.plan_max_minutes * 60000)) throw new Error('計畫有效期限不符');
  const universe = new Set(snapshot.universe.map(x => x.symbol));
  const candidates = new Set(a.candidates), held = new Set(snapshot.account.positions.map(x => x.symbol));
  if (a.candidates.some(x => !universe.has(x))) throw new Error('候選包含資料範圍以外的股票');
  if(a.candidates.length>settings.watch_max_symbols)throw new Error('候選超過本機觀測股上限');
  if (universe.size >= 5 && candidates.size < 5) throw new Error('候選須列出至少 5 檔；可以全部觀望');
  if(a.screening?.entry&&d(a.screening.entry.allocation_fraction).gt(settings.max_order_fraction))throw new Error('策略配置超過硬性單筆上限');
  if(a.screening&&d(a.screening.min_amount).lt(settings.watch_min_amount))throw new Error('策略流動性低於本機觀測門檻');
  if(snapshot.review_only&&a.screening?.entry)throw new Error('盤後檢討不能啟用進場規則');
  for (const decision of a.decisions) {
    if (!candidates.has(decision.symbol) && !held.has(decision.symbol)) throw new Error('決策標的不在候選或持倉內');
    if (decision.action === 'BUY' && (!candidates.has(decision.symbol) || !snapshot.features[decision.symbol]?.sufficient))
      throw new Error('買進標的缺少候選資格或足夠歷史資料');
    if (snapshot.review_only && decision.action !== 'HOLD') throw new Error('盤後檢討不得產生交易委託');
  }
  return { id: randomUUID().replaceAll('-', ''), created_at: now.toISOString(), analysis: a };
}
export function demoAnalysis(snapshot: Snapshot, settings: Settings, now: Date): Analysis {
  if (!snapshot.synthetic) throw new Error('範例策略只能使用虛構行情');
  const candidates = snapshot.universe.slice(0,5).map(x => x.symbol), first = snapshot.universe[0];
  const price = first ? d(first.last) : d(1);
  return AnalysisSchema.parse({ snapshot_id: snapshot.snapshot_id,
    expires_at: new Date(now.getTime() + settings.plan_max_minutes * 60000).toISOString(),
    stance: 'BUY_ALLOWED', candidates, decisions: first && !snapshot.review_only ? [{
      symbol: first.symbol, action: 'BUY', shares: 10, limit_price: price.plus(tickSize(price)).toFixed(),
      entry_when: 'IMMEDIATE', trigger_price: '0', smart: { stop_price: roundPrice(price.times('.95')),
        take_profit: roundPrice(price.times('1.10')), trailing_activate: roundPrice(price.times('1.08')), trailing_fraction: '.03'.replace(/^\./, '0.') },
      reason: '虛構行情流程展示，不是投資策略或真實股票建議' }] : [],
    screening:snapshot.review_only?null:{min_amount:settings.watch_min_amount,min_volume_ratio:'0',rsi_min:0,rsi_max:100,return20_min:'-0.50',
      entry:{signal:'TREND',allocation_fraction:'0.02',max_ma20_distance:'0.10',stop_fraction:'0.05',take_profit_fraction:'0.10',trailing_fraction:'0.03'}},
    summary: 'DEMO：虛構股票，驗證動態觀測、規則進場、部分成交與跨日保護；不是有效獲利策略' });
}
