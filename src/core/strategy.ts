import {StrategyValidationError,validateDecisionTime,validateReplyTimestamp} from './strategy-admission.js';
import { randomUUID } from 'node:crypto';
import { AnalysisSchema, ageSeconds, d, type Analysis, type Bar, type Features, type Plan, type Settings, type Snapshot } from './models.js';
import { roundPrice, tickSize } from './risk.js';
const mean = (x: number[]): number => x.reduce((a, b) => a + b, 0) / x.length;
export function indicators(bars: Bar[]): Features {
  if (bars.length < 20 || bars.some((b,i) => ![b.close,b.high,b.low,b.volume].every(Number.isFinite)
    || b.close <= 0 || b.low<=0 || b.close>b.high || b.close<b.low || b.volume < 0
    || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)||!Number.isFinite(Date.parse(b.date))
    || new Date(b.date).toISOString().slice(0,10)!==b.date || i>0&&b.date<=bars[i-1]!.date))
    return { sufficient: false, sessions: bars.length,issue:'歷史價格、日期或先後順序不合法；不產生交易指標' };
  const closes = bars.map(b => b.close), last = bars.at(-1)!;
  const result: Features = { sufficient: true, sessions: bars.length, asof: last.date,
    daily_amount:last.amount??d(last.close).times(last.volume).toFixed(),
    daily_amount_source:last.amount!==undefined?'TRADE_AMOUNT':'CLOSE_VOLUME_ESTIMATE' };
  for (const n of [5,20,60] as const) if (closes.length >= n) result[`ma${n}`] = mean(closes.slice(-n));
  const changes = closes.slice(-14).map((c, i) => c - closes[closes.length - 15 + i]!);
  const up = mean(changes.map(c => Math.max(0, c))), down = mean(changes.map(c => Math.max(0, -c)));
  result.rsi14 = down ? 100 - 100 / (1 + up / down) : (up ? 100 : 50);
  result.atr14 = mean(bars.slice(-14).map((b, i) => Math.max(b.high - b.low,
    Math.abs(b.high - closes[closes.length - 15 + i]!), Math.abs(b.low - closes[closes.length - 15 + i]!))));
  result.support20 = Math.min(...bars.slice(-20).map(b => b.low));
  result.resistance20 = Math.max(...bars.slice(-20).map(b => b.high));
  if(bars.length>=21){result.previous_resistance20=Math.max(...bars.slice(-21,-1).map(b=>b.high));
    result.ma20_previous=mean(closes.slice(-21,-1));}
  result.last_close=last.close;
  if(bars.length>=25){const base=bars.slice(-25,-5);result.breakout_base20=Math.max(...base.map(b=>b.high));
    result.breakout_range20=result.breakout_base20-Math.min(...base.map(b=>b.low));}
  const averageVolume = mean(bars.slice(-20).map(b => b.volume));
  result.volume_ratio20 = averageVolume ? last.volume / averageVolume : 0;
  result.return20 = last.close / closes.at(-20)! - 1;
  return result;
}
export function validateAnalysis(raw: unknown, snapshot: Snapshot, now: Date, settings: Settings): Plan {
  const expiry=raw&&typeof raw==='object'&&'expires_at' in raw?(raw as {expires_at?:unknown}).expires_at:undefined;
  validateReplyTimestamp(expiry);
  const parsed=AnalysisSchema.safeParse(raw);
  if(!parsed.success)throw new StrategyValidationError(
    parsed.error.issues.some(i=>i.path[0]==='expires_at')?'REPLY_TIME_INVALID':'STRATEGY_SCHEMA_INVALID',
    '策略欄位格式不符，請核對結構化輸出');
  const a=parsed.data;
  if(settings.trade_direction==='reduce_only'&&!snapshot.review_only&&
    (a.stance==='BUY_ALLOWED'||a.decisions.some(d=>d.action==='BUY')||a.screening?.entry))
    throw new StrategyValidationError('STRATEGY_SEMANTIC_INVALID','策略違反僅減碼設定；須使用 REDUCE 或 HOLD_ONLY，且停用買進決策與進場規則');
  // A non-buying stance never grants rule-entry authority, including older saved outputs.
  if(a.stance!=='BUY_ALLOWED'&&a.screening)a.screening.entry=null;
  if (a.snapshot_id !== snapshot.snapshot_id) throw new StrategyValidationError('SNAPSHOT_MISMATCH','Codex 使用的快照不符');
  validateDecisionTime(a.expires_at,snapshot,now,settings);
  const universe = new Set(snapshot.universe.map(x => x.symbol));
  const candidates = new Set(a.candidates), held = new Set(snapshot.account.positions.map(x => x.symbol));
  if(snapshot.review_only){
    if(a.decisions.some(d=>d.action!=='HOLD'))throw new StrategyValidationError('STRATEGY_SEMANTIC_INVALID','盤後檢討不得產生交易委託');
    // A review has no execution authority. Discard valid-shaped protection commentary only.
    // Unknown symbols and malformed fields still fail validation below / in the schema.
    for(const decision of a.decisions)if(universe.has(decision.symbol)||held.has(decision.symbol))decision.smart=null;
  }
  // A held stock may leave today's ranked pool; it is still in the supplied account/history.
  if (a.candidates.some(x => !universe.has(x)&&!held.has(x))) throw new StrategyValidationError('STRATEGY_SEMANTIC_INVALID','候選包含資料範圍以外的股票');
  if(a.candidates.length>settings.watch_max_symbols)throw new StrategyValidationError('STRATEGY_SEMANTIC_INVALID','候選超過本機觀測股上限');
  // An empty HOLD_ONLY plan is a valid decision. Never force unqualified stocks into a strategy.
  if(a.screening?.entry&&d(a.screening.entry.allocation_fraction).gt(settings.max_order_fraction))throw new StrategyValidationError('STRATEGY_SEMANTIC_INVALID','策略配置超過硬性單筆上限');
  if(a.screening&&d(a.screening.min_amount).lt(settings.watch_min_amount))throw new StrategyValidationError('STRATEGY_SEMANTIC_INVALID','策略流動性低於本機觀測門檻');
  if(snapshot.review_only&&a.screening?.entry)throw new StrategyValidationError('STRATEGY_SEMANTIC_INVALID','盤後檢討不能啟用進場規則');
  if(settings.codex_enabled&&!snapshot.review_only)for(const position of snapshot.account.positions.filter(p=>p.shares>0)){
    const decision=a.decisions.find(d=>d.symbol===position.symbol);
    if(!decision?.smart&&decision?.action!=='SELL'&&!snapshot.existing_protection[position.symbol])
      throw new StrategyValidationError('STRATEGY_SEMANTIC_INVALID',`策略缺少持倉 ${position.symbol} 的出場條件；既有委託不會因此改變`);
  }
  for (const decision of a.decisions) {
    // HOLD may explain exclusion of a stock from the supplied universe; it grants no buy authority.
    const excludedHold=decision.action==='HOLD'&&universe.has(decision.symbol)&&decision.smart===null;
    if (!candidates.has(decision.symbol) && !held.has(decision.symbol) && !excludedHold) throw new StrategyValidationError('STRATEGY_SEMANTIC_INVALID','決策標的不在候選或持倉內');
    if (decision.action === 'BUY' && (!candidates.has(decision.symbol) || !snapshot.features[decision.symbol]?.sufficient))
      throw new StrategyValidationError('STRATEGY_SEMANTIC_INVALID','買進標的缺少候選資格或足夠歷史資料');
    if (snapshot.review_only && decision.action !== 'HOLD') throw new StrategyValidationError('STRATEGY_SEMANTIC_INVALID','盤後檢討不得產生交易委託');
  }
  return { id: randomUUID().replaceAll('-', ''), created_at: now.toISOString(), analysis: a, lifecycle:'UNTIL_REPLACED' };
}
export function demoAnalysis(snapshot: Snapshot, settings: Settings, now: Date): Analysis {
  if (!snapshot.synthetic) throw new Error('範例策略只能使用虛構行情');
  const candidates = snapshot.universe.slice(0,5).map(x => x.symbol), first = snapshot.universe[0];
  const price = first ? d(first.last) : d(1),reduceOnly=settings.trade_direction==='reduce_only';
  return AnalysisSchema.parse({ snapshot_id: snapshot.snapshot_id,
    expires_at: new Date(now.getTime() + settings.plan_max_minutes * 60000).toISOString(),
    stance: reduceOnly?'REDUCE':'BUY_ALLOWED', candidates, decisions: first && !snapshot.review_only && !reduceOnly ? [{
      symbol: first.symbol, action: 'BUY', shares: 200, limit_price: price.plus(tickSize(price)).toFixed(),
      entry_when: 'IMMEDIATE', trigger_price: '0', smart: { stop_price: roundPrice(price.times('.95')),
        take_profit: roundPrice(price.times('1.10')), trailing_activate: roundPrice(price.times('1.08')), trailing_fraction: '.03'.replace(/^\./, '0.') },
      conditions:[],reason: '虛構行情流程展示，不是投資策略或真實股票建議' }] : [],
    screening:snapshot.review_only||reduceOnly?null:{min_amount:settings.watch_min_amount,min_volume_ratio:'0',rsi_min:0,rsi_max:100,return20_min:'-0.50',
      entry:{signal:'TREND',allocation_fraction:'0.02',max_ma20_distance:'0.10',stop_fraction:'0.05',take_profit_fraction:'0.10',trailing_fraction:'0.03'}},
    summary: 'DEMO：虛構股票，驗證動態觀測、規則進場、部分成交與跨日保護；不是有效獲利策略' });
}

