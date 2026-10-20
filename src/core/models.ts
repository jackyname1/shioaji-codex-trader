import { Decimal } from 'decimal.js';
import { z } from 'zod';

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });
export const d = (value: Decimal.Value): Decimal => {
  const result = new Decimal(value);
  if (!result.isFinite()) throw new Error('非有限數值');
  return result;
};
export const money = (value: Decimal.Value): string => d(value).toFixed();
const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/).refine(v => d(v).isFinite());
const nonnegative = decimal.refine(v => d(v).gte(0));
const positive = decimal.refine(v => d(v).gt(0));
const fraction = nonnegative.refine(v => d(v).lte(1));
const positiveFraction = positive.refine(v => d(v).lte(1));
const timestamp = z.string().datetime({ offset: true });
const symbol = z.string().regex(/^[0-9A-Z]{4,8}$/);
const quantity = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const InstrumentSchema = z.strictObject({
  symbol, name: z.string(), exchange: z.enum(['TSE', 'OTC']), category: z.string(),
  kind: z.enum(['STOCK', 'ETF', 'OTHER']), reference: nonnegative,
  limit_down: nonnegative, limit_up: nonnegative, suspended: z.boolean(),
  disposition: z.boolean(), attention: z.boolean(), verified_at: timestamp,
});
export type Instrument = z.infer<typeof InstrumentSchema>;
export const QuoteSchema = z.strictObject({
  symbol, last: positive, bid: nonnegative, ask: nonnegative,
  trade_at: timestamp, book_at: timestamp, odd: z.boolean(), simulated: z.boolean(),
  bid_shares: quantity, ask_shares: quantity,
  book_source:z.enum(['OBSERVED','APPROXIMATE']).optional(),
  bid_levels:z.array(z.strictObject({price:nonnegative,shares:quantity})).max(5).optional(),
  ask_levels:z.array(z.strictObject({price:nonnegative,shares:quantity})).max(5).optional(),
});
export type Quote = z.infer<typeof QuoteSchema>;
export const PositionSchema = z.strictObject({
  symbol, shares: quantity, sellable: quantity, average_price: nonnegative, last_price: nonnegative,
  cost_basis: nonnegative.optional(),
}).refine(p => p.sellable <= p.shares, '可賣量超過持倉');
export type Position = z.infer<typeof PositionSchema>;
export const OrderSchema = z.strictObject({
  local_id: z.string().min(1), broker_id: z.string(), tag: z.string().regex(/^[a-zA-Z0-9]{6}$/),
  symbol, action: z.enum(['BUY', 'SELL']), shares: quantity.refine(v => v > 0),
  limit_price: positive, lot: z.enum(['ODD', 'COMMON']),
  status: z.enum(['PREPARED', 'SUBMITTING', 'PENDING', 'PARTIAL', 'FILLED',
    'CANCEL_PENDING', 'CANCELLED', 'REJECTED', 'UNKNOWN']),
  filled: quantity, created_at: timestamp, plan_id: z.string(),
  purpose: z.enum(['ENTRY', 'EXIT', 'PROTECTION', 'EXTERNAL']),
  exit_trigger:z.enum(['STOP','TAKE_PROFIT','TRAILING','BREAKEVEN']).optional(),
  trigger_context:z.strictObject({last:positive,bid:nonnegative,ask:nonnegative,trade_at:timestamp,book_at:timestamp,stop_price:positive,effective_stop:positive}).optional(),
  trigger_reason:z.string().max(3000).optional(),
}).refine(o => o.filled <= o.shares, '成交量超過委託量');
export type Order = z.infer<typeof OrderSchema>;
export const active = (o: Order): boolean => !['FILLED', 'CANCELLED', 'REJECTED'].includes(o.status);
export const remaining = (o: Order): number => o.shares - o.filled;
export const AccountSchema = z.strictObject({
  asof: timestamp, cash: decimal, settlement_debits: nonnegative, settlement_credits: nonnegative,
  positions: z.array(PositionSchema), orders: z.array(OrderSchema), complete: z.boolean(),
  issue: z.string(), daily_buy_amount: nonnegative, daily_buy_count: quantity,
  available: z.object({ cash:z.boolean(), settlements:z.boolean(), positions:z.boolean(), orders:z.boolean() }).optional(),
}).refine(a => new Set(a.positions.map(p => p.symbol)).size === a.positions.length,
  '重複庫存標的');
export type Account = z.infer<typeof AccountSchema>;
export const marketValue = (a: Account): Decimal => a.positions.reduce((sum, p) =>
  sum.plus(d(p.last_price).times(p.shares)), d(0));
export const equity = (a: Account): Decimal => d(a.cash).minus(a.settlement_debits)
  .plus(a.settlement_credits).plus(marketValue(a));
export const SmartSchema = z.strictObject({
  stop_price: positive, take_profit: positive.nullable(), trailing_activate: positive.nullable(),
  trailing_fraction: positive.refine(v => d(v).lt(1)).nullable(),
  // A forecast exit price for cost checks, NOT an executable take-profit order.
  reward_target:positive.nullable().optional(),
}).refine(s => s.take_profit === null || d(s.take_profit).gt(s.stop_price), '停利必須高於停損')
  .refine(s => !s.reward_target || d(s.reward_target).gt(s.stop_price), '收益目標必須高於停損')
  .refine(s => (s.trailing_activate === null) === (s.trailing_fraction === null), '移動停損欄位必須成對');
export type SmartSpec = z.infer<typeof SmartSchema>;
export const ConditionFieldSchema=z.enum(['LAST','BID','ASK','MA5','MA20','MA60','RSI14','ATR14','SUPPORT20','RESISTANCE20','VOLUME_RATIO20','RETURN20']);
// All guards are ANDed with the price trigger. No executable expressions or prose parsing.
export const ConditionSchema=z.strictObject({
  left:ConditionFieldSchema,operator:z.enum(['GT','GTE','LT','LTE']),
  right:z.enum(['VALUE',...ConditionFieldSchema.options]),value:decimal.nullable(),
}).refine(c=>c.right==='VALUE'?c.value!==null:c.value===null,'常數需要 value；指標比較的 value 必須 null');
export type Condition=z.infer<typeof ConditionSchema>;
export const DecisionSchema = z.strictObject({
  symbol, action: z.enum(['BUY', 'SELL', 'HOLD']), shares: quantity.max(999000),
  limit_price: nonnegative, entry_when: z.enum(['IMMEDIATE', 'BELOW', 'ABOVE', 'REBOUND']),
  trigger_price: nonnegative, smart: SmartSchema.nullable(), reason: z.string().min(1).max(1500),
  rebound_fraction:positiveFraction.refine(v=>d(v).lte('.20')).nullable().optional(),
  conditions:z.array(ConditionSchema).max(12).nullable().optional(),
}).refine(x => x.action === 'HOLD' || (x.shares > 0 && d(x.limit_price).gt(0)), '委託需要價格與股數')
  .refine(x => x.action !== 'BUY' || (x.smart !== null && d(x.smart.stop_price).lt(x.limit_price)
    && (x.smart.take_profit === null || d(x.smart.take_profit).gt(x.limit_price))
    && (!x.smart.reward_target || d(x.smart.reward_target).gt(x.limit_price))), '買進保護價不合法')
  .refine(x => x.entry_when==='REBOUND'?x.action==='BUY'&&!!x.rebound_fraction:!x.rebound_fraction,
    '反彈條件僅供買進且需反彈幅度；其他條件不得帶入反彈幅度')
  .refine(x => x.entry_when === 'IMMEDIATE' || d(x.trigger_price).gt(0), '條件單需要觸發價');
export type Decision = z.infer<typeof DecisionSchema>;
// A bounded rule authorizes the deterministic engine, never model-generated executable code.
export const ScreeningSchema = z.strictObject({
  min_amount: nonnegative, min_volume_ratio: nonnegative.refine(v => d(v).lte(10)),
  rsi_min: z.number().min(0).max(100), rsi_max: z.number().min(0).max(100),
  return20_min: decimal.refine(v => d(v).gte(-1) && d(v).lte(2)),
  entry: z.strictObject({
    signal: z.enum(['TREND', 'BREAKOUT20', 'PULLBACK20', 'MULTI']),
    allocation_fraction: positiveFraction.refine(v => d(v).lte('.20')),
    max_ma20_distance: positiveFraction.refine(v => d(v).lte('.10')),
    stop_fraction: positiveFraction.refine(v => d(v).gte('.02') && d(v).lte('.15')),
    take_profit_fraction: positiveFraction.refine(v => d(v).gte('.03') && d(v).lte('.50')),
    trailing_fraction: positiveFraction.refine(v => d(v).gte('.01') && d(v).lte('.10')).nullable(),
  }).nullable(),
}).refine(x => x.rsi_min <= x.rsi_max, 'RSI 範圍不合法');
export type Screening = z.infer<typeof ScreeningSchema>;
export const AnalysisSchema = z.strictObject({
  snapshot_id: z.string().min(1), expires_at: timestamp,
  stance: z.enum(['BUY_ALLOWED', 'HOLD_ONLY', 'REDUCE']), candidates: z.array(symbol).max(20),
  decisions: z.array(DecisionSchema).max(40), summary: z.string().min(1).max(3000),
  screening: ScreeningSchema.nullable().optional(),
}).refine(a => new Set(a.candidates).size === a.candidates.length, '候選不可重複')
  .refine(a => new Set(a.decisions.map(x => x.symbol)).size === a.decisions.length, '每檔限一個決策')
  .refine(a => a.stance === 'BUY_ALLOWED' || a.decisions.every(x => x.action !== 'BUY'), '方向禁止買進');
export type Analysis = z.infer<typeof AnalysisSchema>;
export const PlanSchema = z.strictObject({ id: z.string(), created_at: timestamp, analysis: AnalysisSchema });
export type Plan = z.infer<typeof PlanSchema>;
export const ProtectionSchema = z.strictObject({
  symbol, spec: SmartSchema, high_water: nonnegative, triggered: z.string(), plan_id: z.string(),
  trailing_armed:z.boolean().optional(),observed_at:timestamp.nullable().optional(),
  initial_risk:nonnegative.optional(), protected_floor:nonnegative.optional(),
  break_even_price:nonnegative.optional(), break_even_floor:nonnegative.optional(), break_even_armed:z.boolean().optional(),
  entry_price:nonnegative.optional(), trailing_distance:nonnegative.optional(),
});
export type Protection = z.infer<typeof ProtectionSchema>;
export const EntryTrackSchema=z.strictObject({
  symbol,plan_id:z.string(),lot:z.enum(['ODD','COMMON']),armed:z.boolean(),low_water:nonnegative,
  observed_at:timestamp.nullable(),
  started_at:timestamp.optional(), expires_at:timestamp.optional(),
  status:z.enum(['WAIT','TRACKING','TRIGGERED','EXPIRED','INVALID']).optional(),
  signature:z.string().optional(),
});
export type EntryTrack=z.infer<typeof EntryTrackSchema>;
export const SettingsSchema = z.strictObject({
  mode: z.enum(['demo', 'paper', 'readonly', 'live']).default('paper'),
  auto_execute: z.boolean().default(false), whole_lots: z.boolean().default(false),
  trade_direction:z.enum(['auto','reduce_only']).default('auto'),
  base_url: z.string().url().default('http://127.0.0.1:8080'),
  manage_quote_subscriptions: z.boolean().default(true),
  stock_account_index: quantity.max(50).default(0),
  min_cash_fraction: fraction.default('0.25'), max_order_fraction: positiveFraction.default('0.10'),
  order_budget_basis:z.enum(['EQUITY','AFTER_RESERVE']).default('AFTER_RESERVE'),
  target_exposure_fraction:fraction.default('0.50'),
  min_entry_reward_risk:nonnegative.refine(v=>d(v).lte(10)).default('0'),
  max_trade_risk_fraction:fraction.default('0'),
  max_symbol_fraction: positiveFraction.default('0.20'), max_exposure_fraction: positiveFraction.default('0.75'),
  max_daily_buy_fraction: positiveFraction.default('0.20'), max_daily_buy_orders: quantity.min(1).max(100).default(5),
  daily_loss_fraction: positiveFraction.default('0.02'), price_deviation_fraction: positiveFraction.default('0.03'),
  max_spread_fraction: positiveFraction.default('0.02'), quote_max_age: quantity.min(1).max(300).default(30),
  account_max_age: quantity.min(1).max(300).default(60), cooldown_seconds: quantity.max(86400).default(120),
  fee_rate: fraction.default('0.001425'), minimum_fee: nonnegative.default('20'),
  sell_tax_rate: fraction.default('0.003'),
  entry_strategy_mode:z.enum(['legacy','multi']).default('legacy'),
  // Explicit alternatives for controlled comparisons; never inferred from model prose.
  entry_policy:z.enum(['legacy','trend','pullback','breakout']).default('legacy'),
  execution_sizing:z.enum(['codex','deterministic']).default('deterministic'),
  adaptive_protection:z.boolean().default(true), dynamic_allocation:z.boolean().default(false),
  risk_slippage_fraction:fraction.refine(v=>d(v).lte('0.05')).default('0.001'),
  overnight_gap_fraction:fraction.default('0.05'), max_gap_risk_fraction:fraction.default('0.02'),
  min_net_profit_twd:nonnegative.default('60'),
  entry_tracking_minutes:quantity.min(5).max(360).default(90),
  // Research gates are opt-in and paper/replay only until independent validation.
  portfolio_risk_enabled:z.boolean().default(false),
  portfolio_components:z.enum(['all','drawdown','regime','loss_streak']).default('all'),
  portfolio_drawdown_fraction:positiveFraction.default('0.04'),
  portfolio_cooldown_sessions:quantity.min(1).max(20).default(2),
  portfolio_loss_streak:quantity.min(2).max(10).default(3),
  entry_quality_enabled:z.boolean().default(false),
  max_portfolio_stop_fraction:fraction.default('0'),
  prompt_compaction:z.boolean().default(false),
  research_exit_mode:z.enum(['baseline','fixed','atr_trail']).default('baseline'),
  allow_attention: z.boolean().default(false), codex_enabled: z.boolean().default(false),
  experience_enabled: z.boolean().default(true), experience_limit: quantity.min(5).max(100).default(40),
  official_facts_enabled: z.boolean().default(true), codex_path: z.string().default(''),
  codex_model: z.string().max(200).default(''),
  codex_instruction: z.string().max(4000).default('動態挑選台灣普通現股，保留現金，依趨勢、量能與風控設定進場、停損、停利；資料不足時觀望。'),
  codex_reasoning: z.enum(['default', 'low', 'medium', 'high', 'xhigh']).default('default'),
  codex_timeout_seconds: quantity.min(30).max(1800).default(300),
  premarket_time: clock.default('08:40'), postmarket_time: clock.default('14:00'),
  codex_frequency_version:z.literal(1).default(1),
  codex_daily_call_limit:quantity.min(1).max(50).default(2),
  postmarket_review_enabled:z.boolean().default(false),
  replay_every_sessions:quantity.min(1).max(20).default(5),
  replay_strategy_schedule:z.enum(['fixed','interval']).default('fixed'),
  replay_strategy_times:z.array(clock.refine(v=>v>='08:00'&&v<'13:30')).min(1).max(6)
    .refine(v=>new Set(v).size===v.length,'回測策略時間不可重複').default(['09:15']),
  replay_interval_minutes:quantity.min(10).max(360).default(360),
  replay_max_codex_calls:quantity.min(1).max(2000).default(20),
  replay_review_enabled:z.boolean().default(false),
  replay_execution_sizing:z.enum(['codex','deterministic']).default('deterministic'),
  strategy_schedule: z.enum(['fixed','interval']).default('fixed'),
  strategy_times: z.array(clock.refine(v => v >= '08:00' && v < '13:30')).min(1).max(6)
    .refine(v => new Set(v).size === v.length, '策略時間不可重複').default(['09:15','11:45']),
  schedule_catch_up_minutes: quantity.min(1).max(60).default(20),
  decision_interval_minutes: quantity.min(10).max(360).default(180),
  monitor_interval_seconds: quantity.min(1).max(300).default(3),
  watch_refresh_minutes: quantity.min(1).max(60).default(5),
  auto_watchlist: z.boolean().default(true), watch_max_symbols: quantity.min(5).max(20).default(12),
  watch_remove_after_scans: quantity.min(1).max(12).default(3), watch_min_amount: nonnegative.default('20000000'),
  plan_max_minutes: quantity.min(10).max(1440).default(360),
  candidate_pool_size: quantity.min(20).max(100).default(40), demo_cash: positive.default('100000'),
  start_minimized: z.boolean().default(false), keep_awake: z.boolean().default(true),
}).refine(s => d(s.max_exposure_fraction).plus(s.min_cash_fraction).lte(1), '現金保留加持倉上限不得超過 100%')
  .refine(s => !['live','readonly'].includes(s.mode)||s.entry_policy==='legacy'&&!s.portfolio_risk_enabled&&!s.entry_quality_enabled&&!s.prompt_compaction&&s.research_exit_mode==='baseline', '研究風險與選股功能僅供回放或模擬')
  .refine(s => s.postmarket_time >= '13:40' && s.postmarket_time <= '17:00', '盤後檢討時間須為 13:40–17:00');
export type Settings = z.infer<typeof SettingsSchema>;
/** Upgrade persisted 0.1 settings without carrying manual confirmation gates forward. */
export function storedSettings(raw: unknown): Settings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return SettingsSchema.parse({});
  const value = { ...raw } as Record<string, unknown>;
  delete value.fee_verified; delete value.settlement_debit_sign;
  // Apply the requested low-usage preset once; future edits remain user-controlled.
  if(value.codex_frequency_version===undefined)Object.assign(value,{
    codex_frequency_version:1,strategy_schedule:'fixed',strategy_times:['09:15','11:45'],
    codex_daily_call_limit:2,postmarket_review_enabled:false,execution_sizing:'deterministic',
  });
  // Preserve the effective limit of pre-0.2 saved profiles; the replay preset is separate.
  if(value.order_budget_basis===undefined)value.order_budget_basis='AFTER_RESERVE';
  return SettingsSchema.parse(value);
}
export const SessionSchema = z.strictObject({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), open: z.boolean(), source: z.string().min(1), verified_at: timestamp,
  settlement_open:z.boolean().optional(),known_at:timestamp.optional(),scheduled_open:z.boolean().optional(),scheduled_settlement_open:z.boolean().optional(),
});
export type SessionDay = z.infer<typeof SessionSchema>;
export interface Bar { date: string; close: number; high: number; low: number; volume: number; amount?:string }
export interface Candidate { symbol: string; name: string; last: string; amount: string; source: string }
export interface Features {
  sufficient: boolean; sessions: number; asof?: string; issue?: string;
  ma5?: number; ma20?: number; ma60?: number; rsi14?: number; atr14?: number;
  support20?: number; resistance20?: number; volume_ratio20?: number; return20?: number;
  daily_amount?: string;
  daily_amount_source?:'TRADE_AMOUNT'|'CLOSE_VOLUME_ESTIMATE';
  previous_resistance20?:number; ma20_previous?:number;
  breakout_base20?:number;breakout_range20?:number;last_close?:number;
}
export interface Snapshot {
  snapshot_id: string; asof: string; synthetic: boolean; review_only: boolean;
  account: { cash: string; settlement_debits: string; settlement_credits: string; equity: string;
    daily_buy_amount: string; daily_buy_count: number; positions: Position[];
    open_orders: { symbol: string; action: string; shares: number; limit_price: string }[];
    available_cash?:string;buying_power?:string;minimum_cash_reserve?:string;order_cash_reserved?:string;
    daily_loss_blocked?:boolean;daily_baseline_equity?:string|null;daily_loss_amount?:string|null;daily_loss_ratio?:string|null };
  universe: Candidate[]; features: Record<string, Features>; hard_limits: Record<string, unknown>;
  existing_protection: Record<string, SmartSpec>; fundamentals: Record<string, unknown>;
  smart_tracking?:{entries:EntryTrack[];protections:Protection[]};
  quotes?:Quote[];
  portfolio_risk?:import('./portfolio-risk.js').PortfolioDecision;
  entry_feedback?:{plan_id:string;asof:string;signals:{symbol:string;window:import('./entry-window.js').EntryWindow;state:string;reason:string}[]};
  capital?:import('./capital.js').CapitalSnapshot;
  news: unknown[]; data_limitations: string[];
  instruments?:Record<string,Instrument>;
  data_readiness?:{pool_count:number;history_ready:number;eligible_symbols:string[];history_issues:{symbol:string;issue:string}[]};
  experience?: import('./experience.js').ExperienceContext;
  observation?: { symbols: string[]; refresh_minutes: number; max_symbols: number; next_strategy_at: string | null };
}
export const nowISO = (): string => new Date().toISOString();
export const ageSeconds = (now: Date, stamp: string): number => (now.getTime() - Date.parse(stamp)) / 1000;
export const twDay = (now: Date): string => new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
export const twClock = (now: Date): string => new Date(now.getTime() + 8 * 3600000).toISOString().slice(11, 16);
export const addDays = (day: string, n: number): string => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

