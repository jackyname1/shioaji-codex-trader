import { z } from 'zod';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../core/store.js';
import { TradingCalendar } from '../core/calendar.js';
import { Risk } from '../core/risk.js';
import { AccountSchema, InstrumentSchema, OrderSchema, QuoteSchema, active, addDays, d, money, remaining, twDay,
  type Account, type Bar, type Candidate, type Instrument, type Order, type Quote, type Settings } from '../core/models.js';
import { NoSubmissionError, type Broker } from './types.js';
import { cachedHistory } from '../core/history-cache.js';
import { largestStockScanner, type StockScanner } from './scanner.js';
import { LiveSession } from '../core/live-session.js';
import { BrokerHealthSchema, BrokerError, brokerStageIssue, marketReady, requestStage } from './health.js';

const number = z.union([z.number().finite(), z.string().regex(/^-?\d+(?:\.\d+)?$/)]).transform(v => money(v));
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const selectorSchema = z.object({ account_type: z.string(), broker_id: z.string().min(1), account_id: z.string().min(1), signed: z.boolean() });
const infoSchema = z.object({ simulation: z.boolean(), version: z.string(), agent_harness: z.object({
  enabled: z.boolean(), mode: z.enum(['off','all','production']), audience: z.string().nullable().optional(),
}).optional() });
const healthSchema = BrokerHealthSchema;
const stockSchema = z.object({ security_type: z.literal('STK'), code: z.string(), exchange: z.enum(['TSE','OTC']),
  name: z.string(), category: z.string(), reference: number, limit_down: number, limit_up: number,
  trading_suspended: z.boolean(), disposition_level: count, attention_flag: z.boolean(), update_date: z.string(),
});
const nativeTradeSchema = z.object({ contract: z.object({ code: z.string(), security_type: z.literal('STK'), exchange: z.string() }),
  order: z.object({ id: z.string().min(1), action: z.enum(['Buy','Sell']), price: number, quantity: count,
    order_lot: z.string(), order_cond: z.string(), price_type: z.string(), order_type: z.string(),
    custom_field: z.string().nullable().optional(), account: selectorSchema.omit({signed:true}),
  }), status: z.object({ status: z.string(), order_ts: z.number().finite(), order_quantity: count,
    deal_quantity: count, cancel_quantity: count.optional(), modified_price: number.nullable().optional(),
  }),
});
type NativeTrade = z.infer<typeof nativeTradeSchema>;
const positionSchema = z.object({ id: count, code: z.string(), direction: z.literal('Buy'), cond: z.literal('Cash'),
  quantity: count, yd_quantity: count, price: number, last_price: number });
export function sellableInventory(quantity: number, yesterday: number,
  rows: { date: string; quantity: number; direction: string; cond: string }[], today: string): number {
  if (!quantity) return 0;
  if (!rows.length) throw new Error('缺少庫存取得日期');
  const raw = rows.reduce((sum, r) => sum + r.quantity, 0);
  const factor = raw === quantity ? 1 : raw * 1000 === quantity ? 1000 : 0;
  if (!factor) throw new Error('庫存明細單位或總量不符');
  let old = 0;
  for (const r of rows) {
    if (r.direction !== 'Buy' || r.cond !== 'Cash' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || r.date > today)
      throw new Error('庫存日期或類型不符');
    if (r.date < today) old += r.quantity * factor;
  }
  return Math.max(0, Math.min(quantity, yesterday, old));
}
export function exchangeTimestamp(raw: Record<string, unknown>): string {
  if (typeof raw.datetime === 'string') {
    const text = raw.datetime.replace(' ', 'T');
    const value = /(?:Z|[+-]\d{2}:\d{2})$/.test(text) ? text : text + '+08:00';
    if (!Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  }
  let day: string, clock: string;
  if (typeof raw.date === 'string') day = raw.date;
  else if (Array.isArray(raw.date) && raw.date.length === 3) day = raw.date.map((v, i) => String(v).padStart(i ? 2 : 4, '0')).join('-');
  else throw new Error('行情日期格式不符');
  if (typeof raw.time === 'string') clock = raw.time;
  else if (Array.isArray(raw.time) && raw.time.length >= 3) {
    clock = raw.time.slice(0,3).map(v => String(v).padStart(2,'0')).join(':');
    if (raw.time[3] !== undefined) clock += '.' + String(raw.time[3]).padStart(6,'0');
  } else throw new Error('行情時間格式不符');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(clock)) throw new Error('行情時間格式不符');
  const date = new Date(day + 'T' + clock + '+08:00');
  if (Number.isNaN(date.getTime())) throw new Error('行情時間不合法');
  return date.toISOString();
}
export interface SseFrame { event: string; data: string; id: string }
export function loopbackOrigin(value:string):string {
  const url=new URL(value);
  if(!['127.0.0.1','[::1]','localhost'].includes(url.hostname)||!['http:','https:'].includes(url.protocol)
    ||url.username||url.password||url.pathname!=='/'||url.search||url.hash)
    throw new Error('Shioaji 服務必須綁定本機 loopback，網址不得包含帳密或路徑');
  return url.origin;
}
export class SseParser {
  private buffer = '';
  push(text: string): SseFrame[] {
    this.buffer += text;
    if (this.buffer.length > 2000000) throw new Error('SSE 封包過大');
    const frames: SseFrame[] = [];
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) break;
      const chunk = this.buffer.slice(0, match.index); this.buffer = this.buffer.slice(match.index + match[0].length);
      let event = 'message', id = ''; const data: string[] = [];
      for (const line of chunk.split(/\r?\n/)) {
        if (line.startsWith(':')) continue;
        const pos = line.indexOf(':');
        const key = pos < 0 ? line : line.slice(0,pos), value = pos < 0 ? '' : line.slice(pos + 1).replace(/^ /, '');
        if (key === 'event') event = value; if (key === 'id') id = value; if (key === 'data') data.push(value);
      }
      if (data.length) frames.push({ event, id, data: data.join('\n') });
    }
    return frames;
  }
}
async function boundedText(response: Response, maximum = 10000000): Promise<string> {
  if (!response.body) throw new Error('HTTP 回應空白');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) break;
    total += value.length; if (total > maximum) throw new Error('HTTP 回應過大'); chunks.push(value); }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
export class ShioajiHttpBroker implements Broker {
  readonly production: boolean;
  dirty = true; generation = 0;
  private api: string;
  private stop = new AbortController();
  private streamTask?: Promise<void>;
  private streamReady = false;
  private formatFault = false;
  private info?: z.infer<typeof infoSchema>;
  private selected?: z.infer<typeof selectorSchema>;
  private health?: z.infer<typeof healthSchema>;
  private trades: NativeTrade[] = [];
  private tradesSyncedAt = 0;
  private tradeSubscribed = false;
  private authoritativeRequired = true;
  private subscribed = new Map<string, Record<string, unknown>>();
  private subscriptionGeneration = -1;
  private parts = new Map<string, Partial<Quote>>();
  private changed = new Set<string>();
  private metadata = new Map<string, Instrument>();
  private eventSequence = 0;
  private lastAccount?: Account;
  private seenEvents = new Set<string>();
  constructor(readonly store: Store, public settings: Settings, readonly allowLive = false,
    private readonly fetcher: typeof fetch = fetch, private readonly liveSession = new LiveSession()) {
    this.production = settings.mode === 'live';
    this.api = loopbackOrigin(settings.base_url) + '/api/v1';
  }
  async request(path: string, body?: unknown, options: { timeoutMs?: number } = {}): Promise<unknown> {
    const stage = requestStage(path);
    try {
    const response = await this.fetcher(this.api + path, { method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
      signal: AbortSignal.any([this.stop.signal, AbortSignal.timeout(options.timeoutMs ?? (path.startsWith('/portfolio/') ? 45000 : 15000))]) });
    if (!response.ok) { await response.body?.cancel(); throw new BrokerError(`Shioaji ${stage}讀取失敗（HTTP ${response.status}），請重試或檢查 API 權限`,response.status >= 500,response.status); }
    return JSON.parse(await boundedText(response)) as unknown;
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      throw new BrokerError(`Shioaji ${stage}暫時無法取得，請檢查本機服務與網路`,!this.stop.signal.aborted);
    }
  }
  private async read<T>(path:string,schema:z.ZodType<T>,body?:unknown):Promise<T> {
    try {return schema.parse(await this.request(path,body));}
    catch(error){throw brokerStageIssue(requestStage(path),error);}
  }
  private selectors(): { account_type: string; broker_id: string; account_id: string } {
    if (!this.selected) throw new Error('證券帳戶尚未選定');
    return { account_type: 'S', broker_id: this.selected.broker_id, account_id: this.selected.account_id };
  }
  async connect(): Promise<void> {
    this.info = infoSchema.parse(await this.request('/info'));
    if (this.settings.mode !== 'demo' && this.info.simulation) throw new BrokerError('Shioaji 模擬服務不提供本程式需要的真實歷史行情');
    const health = this.health = healthSchema.parse(await this.request('/health'));
    if (!marketReady(health)) throw new BrokerError(health.token_stale || health.token_expires_in_seconds === 0
      ? 'Shioaji 登入已過期，請重新連線' : 'Shioaji 登入正在恢復，請稍候重試');
    // Historical/local paper trading needs market access, never the user's bank balance or trade reports.
    if (this.settings.mode === 'paper') { this.streamTask = this.streamLoop(); return; }
    const accounts = z.array(selectorSchema).parse(await this.request('/auth/accounts')).filter(a => a.account_type === 'S');
    this.selected = accounts[this.settings.stock_account_index];
    if (!this.selected) throw new BrokerError('Shioaji 選定的證券帳戶不存在，請選擇有效帳戶');
    const identity = { ...this.selectors(), simulation: this.info.simulation };
    const fingerprint = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const prior = this.store.get<string>('account_fingerprint');
    if (prior && prior !== fingerprint) {
      // Upgrade a port-bound legacy identity only after the SAME selected account matches its old hash.
      const origin = this.store.get<string>('legacy_account_origin') ?? this.settings.base_url;
      const legacy = createHash('sha256').update(JSON.stringify({ ...identity, origin: loopbackOrigin(origin) + '/api/v1' })).digest('hex');
      if (this.store.get('account_identity_version') === 2 || prior !== legacy)
        throw new BrokerError('Shioaji 帳戶身分已變更，請選擇新的獨立帳戶資料');
    }
    this.store.set('account_fingerprint', fingerprint);
    this.store.set('account_identity_version', 2); this.store.delete('legacy_account_origin');
    const saved = this.store.get<Array<[string, Record<string, unknown>]>>('quote_subscriptions') ?? [];
    this.subscribed = new Map(saved);
    this.streamTask = this.streamLoop();
  }
  async close(): Promise<void> { this.stop.abort(); await this.streamTask; this.parts.clear(); }
  liveStatus(): { account: string; issues: string[] } {
    const issues: string[] = [], health = this.health;
    if (!this.production || !this.allowLive) issues.push('請切換至實盤模式');
    if (!this.selected?.signed) issues.push('證券帳戶尚未核對');
    if (health?.ca_expired !== false || !health.ca_expires_in_days || health.ca_expires_in_days <= 0) issues.push('請載入有效 CA 憑證後重新連線');
    if (!health || health.token_stale || (health.token_expires_in_seconds !== undefined && health.token_expires_in_seconds <= 0)) issues.push('API 登入尚未確認或已過期');
    if (health?.session_recovering || health?.status === 'unhealthy') issues.push('Shioaji 登入正在恢復');
    if (this.info?.agent_harness?.enabled || this.info?.agent_harness?.audience) issues.push('官方服務需要可信任主機能力票證');
    if (!this.streamReady || this.formatFault) issues.push('行情串流尚未完成核對');
    return { account: this.selected ? `${this.selected.broker_id} · 尾碼 ${this.selected.account_id.slice(-4)}` : '尚未連接帳戶', issues };
  }
  async verifyLiveConnection(): Promise<void> {
    if (!this.production || !this.allowLive) throw new NoSubmissionError('請切換至實盤模式');
    this.info = infoSchema.parse(await this.request('/info'));
    if (this.info.simulation) { this.liveSession.revoke(); throw new NoSubmissionError('服務切換成模擬模式，禁止實盤'); }
    this.health = healthSchema.parse(await this.request('/health'));
    const accounts = z.array(selectorSchema).parse(await this.request('/auth/accounts')).filter(a => a.account_type === 'S');
    const selected = accounts[this.settings.stock_account_index];
    if (!selected?.signed || selected.broker_id !== this.selected?.broker_id || selected.account_id !== this.selected?.account_id) {
      this.liveSession.revoke(); throw new NoSubmissionError('實盤帳戶已變更，請重新連線並核對');
    }
    const issues = this.liveStatus().issues;
    if (issues.length) throw new NoSubmissionError(issues.join('；'));
  }
  private invalidate(): void { this.parts.clear(); this.changed.clear(); this.generation++; this.dirty = true; this.authoritativeRequired = true; }
  private async streamLoop(): Promise<void> {
    let attempt = 0;
    while (!this.stop.signal.aborted) {
      const connection = new AbortController(); let watchdog: NodeJS.Timeout | undefined;
      const touch = (): void => { clearTimeout(watchdog); watchdog = setTimeout(() => connection.abort(), 75000); };
      try {
        touch();
        const response = await this.fetcher(this.api + '/stream/data?region=TW&security_type=STK', {
          headers: { Accept: 'text/event-stream' }, redirect: 'error', signal: AbortSignal.any([this.stop.signal, connection.signal]) });
        if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('SSE 無法連接');
        this.streamReady = true; this.formatFault=false; this.invalidate(); attempt = 0;
        const reader = response.body.getReader(), decoder = new TextDecoder(), parser = new SseParser();
        try { for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          touch();
          for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
            try { this.handleFrame(frame); }
            catch { this.formatFault = true; this.invalidate(); throw new Error('SSE 格式異常，須重啟並核對'); }
          }
        } } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      } catch { /* A disconnect invalidates quotes; mutations are never retried here. */ }
      finally { clearTimeout(watchdog); this.streamReady = false; this.invalidate(); }
      if (!this.stop.signal.aborted) await delay(Math.min(15000, 1000 * 2 ** Math.min(attempt++,4)), undefined, { signal: this.stop.signal }).catch(() => undefined);
    }
  }
  handleFrame(frame: SseFrame): void {
    if (frame.event === 'heartbeat') return;
    if (frame.event.includes('gap') || frame.event === 'contract_event') { this.metadata.clear(); this.invalidate(); return; }
    if (frame.event === 'order_event' || frame.event === 'order_deal_event') {
      if (frame.id && this.seenEvents.has(frame.id)) return;
      if (frame.id) { this.seenEvents.add(frame.id); if (this.seenEvents.size > 5000) this.seenEvents.delete(this.seenEvents.values().next().value!); }
      this.eventSequence++; this.dirty = true; return;
    }
    if (!['tick_stk','bidask_stk'].includes(frame.event)) return;
    const raw = JSON.parse(frame.data) as Record<string, unknown>;
    const symbol = z.string().regex(/^[0-9A-Z]{4,8}$/).parse(raw.code), odd = z.boolean().parse(raw.intraday_odd);
    if (z.boolean().parse(raw.simtrade)) return;
    const key = `${symbol}:${odd}`, timestamp = exchangeTimestamp(raw), part = this.parts.get(key) ?? { symbol, odd, simulated: false };
    if (frame.event === 'tick_stk') {
      if (part.trade_at && timestamp < part.trade_at) return;
      part.last = number.parse(raw.close); part.trade_at = timestamp;
    } else {
      if (part.book_at && timestamp < part.book_at) return;
      const bids = z.array(number).min(1).parse(raw.bid_price), asks = z.array(number).min(1).parse(raw.ask_price);
      const bidVolume = z.array(count).min(1).parse(raw.bid_volume), askVolume = z.array(count).min(1).parse(raw.ask_volume);
      part.bid = bids[0]!; part.ask = asks[0]!; part.bid_shares = bidVolume[0]! * (odd ? 1 : 1000);
      part.ask_shares = askVolume[0]! * (odd ? 1 : 1000); part.book_at = timestamp;
      if(bids.length!==bidVolume.length||asks.length!==askVolume.length)throw new Error('五檔價格與數量長度不符');
      part.bid_levels=bids.slice(0,5).map((price,i)=>({price,shares:bidVolume[i]!*(odd?1:1000)}));
      part.ask_levels=asks.slice(0,5).map((price,i)=>({price,shares:askVolume[i]!*(odd?1:1000)}));
    }
    this.parts.set(key, part); this.changed.add(key);
  }
  quotes(_now: Date): Quote[] {
    const result: Quote[] = [];
    for (const key of this.changed) { const q = QuoteSchema.safeParse(this.parts.get(key)); if (q.success) result.push(q.data); }
    this.changed.clear(); return result;
  }
  async subscribe(symbols: string[], wholeLots: boolean): Promise<void> {
    const generation = this.generation;
    const metadata = await this.instruments(symbols, new Date()), wanted = new Map<string, Record<string, unknown>>();
    for (const symbol of symbols) {
      const instrument = metadata[symbol]; if (!instrument) continue;
      for (const odd of wholeLots ? [true,false] : [true]) for (const quoteType of ['Tick','BidAsk']) {
        const body = { security_type: 'STK', region: 'TW', code: symbol, exchange: instrument.exchange, target_code:null, quote_type: quoteType, intraday_odd: odd };
        wanted.set(`${symbol}:${odd}:${quoteType}`, body);
      }
    }
    if (wanted.size > 160) throw new Error('行情需求超過本程式 160 個訂閱上限，請減少觀測或持倉範圍');
    if (this.settings.manage_quote_subscriptions) for (const [key, body] of this.subscribed) if (!wanted.has(key)) {
      const result = await this.request('/stream/unsubscribe', body) as { success?: boolean };
      if (result.success !== true) throw new BrokerError('Shioaji 行情退訂未成功，正在保留原訂閱並重試');
      this.subscribed.delete(key); this.store.set('quote_subscriptions', [...this.subscribed]);
      const quoteKey = key.slice(0, key.lastIndexOf(':')); this.parts.delete(quoteKey); this.changed.delete(quoteKey);
    }
    const additions = [...wanted.keys()].filter(key => !this.subscribed.has(key));
    if (this.subscribed.size + additions.length > 160) throw new Error('共享行情模式已達 160 個訂閱，請使用專用 Shioaji 服務或啟用訂閱管理');
    for (const [key, body] of wanted) if (!this.subscribed.has(key) || this.subscriptionGeneration !== this.generation) {
      const result = await this.request('/stream/subscribe', body) as { success?: boolean };
      if (result.success !== true) throw new BrokerError('Shioaji 行情訂閱未成功，請確認行情權限或訂閱額度'); this.subscribed.set(key, body);
      this.store.set('quote_subscriptions', [...this.subscribed]);
    }
    this.subscriptionGeneration = generation;
    // Engine includes held inventory, pending orders and protection in wanted. Release only keys this app requested.
    // The native API has no per-client ownership: managed rotation requires a dedicated native service.
    // In shared mode keep old subscriptions, bounded to 160; never unsubscribe another client's trade reports.
  }
  async instruments(symbols: string[], now: Date): Promise<Record<string, Instrument>> {
    const result: Record<string, Instrument> = {};
    for (const symbol of symbols) {
      const cached = this.metadata.get(symbol);
      if (cached && twDay(new Date(cached.verified_at)) === twDay(now)) { result[symbol] = cached; continue; }
      const raw = await this.read(`/data/contracts/${encodeURIComponent(symbol)}/info?region=TW&security_type=STK`,stockSchema);
      if (raw.code !== symbol) throw new BrokerError('Shioaji 商品資料回傳代碼不符，暫停使用該商品');
      // Source date, not fetch date, controls readiness. Old limits must never authorize an order.
      const sourceDate = /^\d{4}-\d{2}-\d{2}$/.test(raw.update_date) ? raw.update_date : '';
      if (!sourceDate) throw new BrokerError('Shioaji 商品資料日期無法核對，等待契約更新');
      const value = InstrumentSchema.parse({ symbol, name: raw.name, exchange: raw.exchange, category: raw.category,
        kind: /^[1-9]\d{3}$/.test(symbol) ? 'STOCK' : symbol.startsWith('00') ? 'ETF' : 'OTHER',
        reference: raw.reference, limit_down: raw.limit_down, limit_up: raw.limit_up,
        suspended: raw.trading_suspended, disposition: raw.disposition_level > 0, attention: raw.attention_flag,
        verified_at: `${sourceDate}T00:00:00+08:00` });
      this.metadata.set(symbol, value); result[symbol] = value;
    }
    return result;
  }
  private async refreshTrades(force = false): Promise<void> {
    if (!this.tradeSubscribed) {
      const subscription = await this.request('/auth/subscribe_trade', this.selectors()) as { subscribe_trade?: boolean };
      if (subscription.subscribe_trade !== true) throw new BrokerError('Shioaji 委託回報尚未訂閱，正在重新核對');
      this.tradeSubscribed = true;
    }
    const generation = this.generation;
    const refresh = force || this.authoritativeRequired || Date.now() - this.tradesSyncedAt >= 60000;
    const values = await this.read('/order/trades',z.array(nativeTradeSchema), { ...this.selectors(), refresh });
    if (values.some(t => t.order.account.broker_id !== this.selected?.broker_id || t.order.account.account_id !== this.selected?.account_id))
      throw new BrokerError('Shioaji 委託回傳帳戶不符，請重新連線');
    this.trades = values;
    if (refresh) { this.tradesSyncedAt = Date.now(); if (generation === this.generation) this.authoritativeRequired = false; }
  }
  normalizeTrade(trade: NativeTrade, local?: Order): Order {
    const native = trade.order, status = trade.status;
    const factor = ['Common','Fixing'].includes(native.order_lot) ? 1000 : 1;
    const quantity = (status.order_quantity || native.quantity) * factor, filled = status.deal_quantity * factor;
    const action = native.action === 'Buy' ? 'BUY' : 'SELL';
    const states: Record<string, Order['status']> = { Filled: 'FILLED', Cancelled: 'CANCELLED', PartFilled: 'PARTIAL',
      Failed: 'REJECTED', Inactive: 'REJECTED', Submitted: 'PENDING', PreSubmitted: 'SUBMITTING', PendingSubmit: 'SUBMITTING' };
    const mapped = states[status.status] ?? 'UNKNOWN';
    const modifiedPrice = d(status.modified_price ?? '0');
    const price = modifiedPrice.gt(0) ? modifiedPrice : d(native.price);
    if (local) {
      if (local.symbol !== trade.contract.code || local.action !== action || local.shares !== quantity
        || !d(local.limit_price).eq(price) || native.custom_field !== local.tag
        || native.order_lot !== (local.lot === 'ODD' ? 'IntradayOdd' : 'Common')
        || native.order_cond !== 'Cash' || native.price_type !== 'LMT' || native.order_type !== 'ROD'
        || filled < local.filled) throw new Error('券商與本機委託資料不符');
      return OrderSchema.parse({ ...local, broker_id: native.id,
        status: local.status === 'CANCEL_PENDING' && ['PENDING','PARTIAL','SUBMITTING'].includes(mapped) ? 'CANCEL_PENDING' : mapped, filled });
    }
    const reservePrice = price.gt(0) ? price.toFixed() : this.metadata.get(trade.contract.code)?.limit_up;
    if (!reservePrice || d(reservePrice).lte(0)) throw new BrokerError('Shioaji 外部市價委託尚無可核對的預留價格，等待商品資料');
    // Unknown/unsupported external orders freeze new orders while still reserving cash/inventory.
    const supported = native.order_cond === 'Cash' && ['Common','IntradayOdd'].includes(native.order_lot);
    return OrderSchema.parse({ local_id: 'external-' + native.id, broker_id: native.id,
      tag: createHash('sha256').update(native.id).digest('hex').slice(0,6), symbol: trade.contract.code,
      action, shares: quantity, limit_price: reservePrice, lot: factor === 1000 ? 'COMMON' : 'ODD',
      status: supported ? mapped : 'UNKNOWN', filled, created_at: new Date(status.order_ts * 1000).toISOString(),
      plan_id: 'external', purpose: 'EXTERNAL' });
  }
  async reconcile(orders: Order[], force = false): Promise<Order[]> {
    await this.refreshTrades(force || orders.some(o => ['UNKNOWN','SUBMITTING','PREPARED','CANCEL_PENDING'].includes(o.status)));
    return orders.map(local => {
      const matches = this.trades.filter(t => local.broker_id ? t.order.id === local.broker_id : t.order.custom_field === local.tag);
      if (matches.length !== 1) return { ...local, status: 'UNKNOWN' as const };
      try { return this.normalizeTrade(matches[0]!, local); } catch { return { ...local, status: 'UNKNOWN' as const }; }
    });
  }
  async account(now: Date): Promise<Account> {
    const start = new Date(), sequence = this.eventSequence, generation = this.generation;
    const previous = this.lastAccount;
    const available={cash:previous?.available?.cash??!!previous,settlements:previous?.available?.settlements??!!previous,
      positions:previous?.available?.positions??!!previous,orders:previous?.available?.orders??!!previous};
    let cash=previous?.cash??'0',debits=previous?.settlement_debits??'0',credits=previous?.settlement_credits??'0';
    let positions=previous?.positions??[],orders=previous?.orders??[],buys=orders.filter(o=>o.action==='BUY'&&twDay(new Date(o.created_at))===twDay(now)&&(active(o)||o.filled>0));
    const issues:string[]=[];let tradesCurrent=false;
    const failed=(stage:string,error:unknown):void=>{issues.push(brokerStageIssue(stage,error).message);};
    // Account panels are independent, as in Pro. A failed report/bank query must not discard a successful positions query.
    try {
      await this.refreshTrades();
      const relevant=this.trades.filter(t=>t.status.deal_quantity>0||!['Filled','Cancelled','Failed','Inactive'].includes(t.status.status));
      await this.instruments([...new Set(relevant.filter(t=>d(t.order.price).lte(0)).map(t=>t.contract.code))],now);
      orders=relevant.map(t=>this.normalizeTrade(t));available.orders=true;
      buys=orders.filter(o=>o.action==='BUY'&&twDay(new Date(o.created_at))===twDay(now)&&(active(o)||o.filled>0));
      const health=await this.read('/order/trade_cache_health',z.object({state:z.enum(['Unknown','Healthy','Degraded']),reasons:z.array(z.object({reason:z.string()}))}),this.selectors());
      if(health.state!=='Healthy'||health.reasons.length){this.authoritativeRequired=true;throw new BrokerError('Shioaji 委託回報尚未完成核對，稍後自動重試');}
      tradesCurrent=true;available.orders=true;
    } catch(error){failed('委託回報',error);}
    const readBalance=async():Promise<void>=>{try {
      const balance=await this.read('/portfolio/account_balance',z.object({acc_balance:number,date:z.string(),errmsg:z.string()}),this.selectors());
      if(balance.errmsg.trim())throw new BrokerError('Shioaji 交割戶餘額查詢未成功，帳務稍後自動重試；歷史模擬仍可使用');
      // A valid balance remains visible even when its broker date needs refreshing. Freshness still gates trading.
      cash=balance.acc_balance;available.cash=true;
      if(!/^\d{4}-\d{2}-\d{2}/.test(balance.date)||balance.date.slice(0,10)!==twDay(now))
        throw new BrokerError('Shioaji 交割戶餘額日期尚未更新，帳務稍後自動重試；歷史模擬仍可使用');
    } catch(error){failed('交割戶餘額',error);}};
    const readSettlements=async():Promise<void>=>{try {
      const rows=await this.read('/portfolio/settlements',z.array(z.object({amount:number,date:z.string(),T:z.number().int()})),this.selectors());
      // Reserve all outstanding amounts; never spend unsettled credits or require a manual sign setting.
      debits=rows.filter(r=>r.T>=0).reduce((sum,r)=>sum.plus(d(r.amount).abs()),d(0)).toFixed();credits='0';available.settlements=true;
    } catch(error){failed('交割款',error);}};
    const readPositions=async():Promise<void>=>{try {
      const rows=await this.read('/portfolio/position_unit',z.array(positionSchema),{...this.selectors(),unit:'Share'});
      const grouped=new Map<string,{code:string;quantity:number;yd_quantity:number;cost:ReturnType<typeof d>;last_price:string}>();
      for(const p of rows.filter(p=>p.quantity>0)){
        const old=grouped.get(p.code);
        grouped.set(p.code,{code:p.code,quantity:(old?.quantity??0)+p.quantity,yd_quantity:(old?.yd_quantity??0)+p.yd_quantity,
          cost:(old?.cost??d(0)).plus(d(p.price).times(p.quantity)),last_price:p.last_price});
      }
      positions=[...grouped.values()].map(p=>{
        const acquired=tradesCurrent?buys.filter(o=>o.symbol===p.code).reduce((sum,o)=>sum+o.filled,0):p.quantity;
        // Share and yd_quantity already use shares. Detail has no unit selector and is not a display/readiness gate.
        // Subtract all known same-day purchases as well: selling old inventory cannot make new shares day-tradable.
        return {symbol:p.code,shares:p.quantity,sellable:Math.max(0,Math.min(p.quantity,p.yd_quantity,p.quantity-acquired)),average_price:p.cost.div(p.quantity).toFixed(),last_price:p.last_price};
      });available.positions=true;
    } catch(error){failed('庫存',error);}};
    await Promise.all([readBalance(),readSettlements(),readPositions()]);
    if(sequence!==this.eventSequence||generation!==this.generation)issues.push('Shioaji 快照取得期間有委託或連線變動，等待重新核對');
    this.dirty = sequence !== this.eventSequence || generation !== this.generation;
    const issue=[...new Set(issues)].join('；');
    this.lastAccount = AccountSchema.parse({ asof: start.toISOString(), cash, settlement_debits: debits,
      settlement_credits: credits, positions, orders, complete: !issue, issue,available,
      daily_buy_count: buys.length, daily_buy_amount: buys.reduce((sum,o) => sum.plus(d(o.limit_price).times(active(o) ? o.shares : o.filled)),d(0)).toFixed() });
    return this.lastAccount;
  }
  async discover(countRequested: number, now: Date): Promise<Candidate[]> {
    const collected = new Map<string, Candidate>();
    for (const scannerType of ['AmountRank','VolumeRank','ChangePercentRank'] as StockScanner[]) {
      const raw = await largestStockScanner(this,scannerType,twDay(now),countRequested*2);
      for (const r of raw) if (/^[1-9]\d{3}$/.test(r.code) && d(r.close).gt(0)) collected.set(r.code,
        { symbol: r.code, name: r.name, last: r.close, amount: r.total_amount, source: 'Shioaji ' + scannerType });
    }
    const ranked = [...collected.values()].sort((a,b) => d(b.amount).cmp(a.amount));
    const result: Candidate[] = [];
    for (const row of ranked) {
      try { const m = (await this.instruments([row.symbol],now))[row.symbol];
        if (m?.kind === 'STOCK' && !m.suspended && !m.disposition && (!m.attention || this.settings.allow_attention)) result.push(row);
      } catch { /* A stock without verified metadata is excluded. */ }
      if (result.length >= countRequested) break;
    }
    return result;
  }
  async history(symbol: string, now: Date): Promise<Bar[]> {
    const m = (await this.instruments([symbol],now))[symbol]; if (!m) return [];
    const raw = await cachedHistory(this, this.store.path === ':memory:' ? undefined : join(dirname(this.store.path), 'history-cache'),
      symbol, m.exchange, addDays(twDay(now),-150), addDays(twDay(now),-1), now.toISOString(), this.stop.signal);
    const grouped = new Map<string, Bar>();
    for (const row of raw) {
      const day = twDay(new Date(row.at)); if (day >= twDay(now)) continue;
      const b = grouped.get(day), high = Number(row.high), low = Number(row.low), close = Number(row.close), volume = row.volume_shares;
      grouped.set(day, { date: day, high: b ? Math.max(b.high,high) : high, low: b ? Math.min(b.low,low) : low,
        close, volume: (b?.volume ?? 0) + volume,
        ...(row.amount_twd!==undefined&&(!b||b.amount!==undefined)?{amount:d(b?.amount??0).plus(row.amount_twd).toFixed()}:{}) });
    }
    return [...grouped.values()].sort((a,b) => a.date.localeCompare(b.date));
  }
  private async mutationReady(scope:'trade'|'cancel'='trade'): Promise<void> {
    if (!this.liveSession.authorized(this.store.get('account_fingerprint'),scope)) throw new NoSubmissionError('請先確認本次實盤授權');
    await this.verifyLiveConnection();
    if (!this.liveSession.authorized(this.store.get('account_fingerprint'),scope)) throw new NoSubmissionError('本次實盤授權已關閉');
  }
  async submit(o: Order): Promise<Order> {
    let m: Instrument | undefined;
    try {
      await this.mutationReady();
      m = (await this.instruments([o.symbol],new Date()))[o.symbol];
      const now = new Date();
      if (!m || !this.lastAccount || this.dirty) throw new NoSubmissionError('帳戶或商品資料尚未重新核對');
      const q = QuoteSchema.safeParse(this.parts.get(`${o.symbol}:${o.lot === 'ODD'}`));
      const baseline = this.store.get<{equity:string}>('baseline_' + twDay(now))?.equity;
      const reasons = new Risk(this.settings,new TradingCalendar(this.store)).check(o,this.lastAccount,q.success ? q.data : undefined,m,now,baseline);
      if (reasons.length) throw new NoSubmissionError(reasons.join('；'));
      if (o.purpose === 'ENTRY') {
        const plan = this.store.plan();
        if (!plan || plan.id !== o.plan_id || Date.parse(plan.analysis.expires_at) <= now.getTime()) throw new NoSubmissionError('買進計畫已過期');
      }
      if (!this.liveSession.authorized(this.store.get('account_fingerprint'))) throw new NoSubmissionError('本次實盤授權已關閉');
    } catch (error) {
      if (error instanceof NoSubmissionError) throw error;
      throw new NoSubmissionError('送單前連線或資料核對失敗，未送出券商委託');
    }
    const payload = { contract: { security_type:'STK',exchange:m.exchange,code:o.symbol }, stock_order:{
      action: o.action === 'BUY' ? 'Buy' : 'Sell', price: Number(o.limit_price), quantity: o.lot === 'ODD' ? o.shares : o.shares / 1000,
      price_type:'LMT', order_type:'ROD', order_lot:o.lot === 'ODD' ? 'IntradayOdd' : 'Common', order_cond:'Cash',
      daytrade_short:false, custom_field:o.tag, account:{ broker_id:this.selected!.broker_id,account_id:this.selected!.account_id } } };
    // Exactly one network attempt; any uncertain outcome is reconciled by the engine.
    const trade = nativeTradeSchema.parse(await this.request('/order/place_order',payload));
    return this.normalizeTrade(trade,o);
  }
  async cancel(o: Order): Promise<Order> {
    try { await this.mutationReady('cancel'); await this.refreshTrades(true); }
    catch { throw new NoSubmissionError('撤單前連線或授權核對失敗，未送出撤單'); }
    const trade = this.trades.find(t => t.order.id === o.broker_id); if (!trade) throw new Error('撤單前查不到委託');
    const current = this.normalizeTrade(trade,o); if (!active(current)) return current;
    if (!this.liveSession.authorized(this.store.get('account_fingerprint'),'cancel')) throw new NoSubmissionError('本次實盤授權已關閉，未送出撤單');
    const result = nativeTradeSchema.parse(await this.request('/order/cancel_order',{ trade_id:o.broker_id }));
    return this.normalizeTrade(result,{ ...o,status:'CANCEL_PENDING' });
  }
}
