import { z } from 'zod';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../core/store.js';
import { TradingCalendar } from '../core/calendar.js';
import { Risk } from '../core/risk.js';
import { AccountSchema, InstrumentSchema, OrderSchema, QuoteSchema, active, addDays, d, money, remaining, twDay,
  type Account, type Bar, type Candidate, type Instrument, type Order, type Quote, type Settings } from '../core/models.js';
import { NoSubmissionError, type Broker } from './types.js';
import { historicalKbars } from './historical-format.js';

const number = z.union([z.number().finite(), z.string().regex(/^-?\d+(?:\.\d+)?$/)]).transform(v => money(v));
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const selectorSchema = z.object({ account_type: z.string(), broker_id: z.string().min(1), account_id: z.string().min(1), signed: z.boolean() });
const infoSchema = z.object({ simulation: z.boolean(), version: z.string(), agent_harness: z.object({
  enabled: z.boolean(), mode: z.enum(['off','all','production']), audience: z.string().nullable().optional(),
}).optional() });
const healthSchema = z.object({ status: z.literal('healthy'), token_stale: z.boolean().optional(),
  token_expires_in_seconds: z.number().optional(), ca_expired: z.boolean().optional(), ca_expires_in_days: z.number().optional() });
const stockSchema = z.object({ security_type: z.literal('STK'), code: z.string(), exchange: z.enum(['TSE','OTC']),
  name: z.string(), category: z.string(), reference: number, limit_down: number, limit_up: number,
  trading_suspended: z.boolean(), disposition_level: count, attention_flag: z.boolean(), update_date: z.string(),
});
const nativeTradeSchema = z.object({ contract: z.object({ code: z.string(), security_type: z.literal('STK'), exchange: z.string() }),
  order: z.object({ id: z.string().min(1), action: z.enum(['Buy','Sell']), price: number, quantity: count,
    order_lot: z.string(), order_cond: z.string(), price_type: z.string(), order_type: z.string(),
    custom_field: z.string().nullable().optional(), account: selectorSchema,
  }), status: z.object({ status: z.string(), order_ts: z.number().finite(), order_quantity: count,
    deal_quantity: count, cancel_quantity: count.optional(), modified_price: number.nullable().optional(),
  }),
});
type NativeTrade = z.infer<typeof nativeTradeSchema>;
const positionSchema = z.object({ id: count, code: z.string(), direction: z.literal('Buy'), cond: z.literal('Cash'),
  quantity: count, yd_quantity: count, price: number, last_price: number });
const detailSchema = z.object({ date: z.string(), direction: z.literal('Buy'), cond: z.literal('Cash'), quantity: count });
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
  private trades: NativeTrade[] = [];
  private subscribed = new Map<string, Record<string, unknown>>();
  private parts = new Map<string, Partial<Quote>>();
  private changed = new Set<string>();
  private metadata = new Map<string, Instrument>();
  private eventSequence = 0;
  private lastAccount?: Account;
  private seenEvents = new Set<string>();
  constructor(readonly store: Store, public settings: Settings, readonly allowLive = false,
    private readonly fetcher: typeof fetch = fetch) {
    this.production = settings.mode === 'live';
    this.api = loopbackOrigin(settings.base_url) + '/api/v1';
  }
  async request(path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetcher(this.api + path, { method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
      signal: AbortSignal.any([this.stop.signal, AbortSignal.timeout(15000)]) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Shioaji HTTP ${response.status}；請在本機核對服務狀態`); }
    return JSON.parse(await boundedText(response)) as unknown;
  }
  private selectors(): { account_type: string; broker_id: string; account_id: string } {
    if (!this.selected) throw new Error('證券帳戶尚未選定');
    return { account_type: 'S', broker_id: this.selected.broker_id, account_id: this.selected.account_id };
  }
  async connect(): Promise<void> {
    this.info = infoSchema.parse(await this.request('/info'));
    if (this.production && this.info.simulation) throw new Error('實盤模式不能連到模擬服務');
    const health = healthSchema.parse(await this.request('/health'));
    if (health.token_stale || (health.token_expires_in_seconds !== undefined && health.token_expires_in_seconds <= 0))
      throw new Error('Shioaji 登入已過期');
    if (this.production && (health.ca_expired !== false || !health.ca_expires_in_days || health.ca_expires_in_days <= 0))
      throw new Error('正式下單前必須確認 CA 已啟用且尚未過期');
    const accounts = z.array(selectorSchema).parse(await this.request('/auth/accounts')).filter(a => a.account_type === 'S');
    this.selected = accounts[this.settings.stock_account_index];
    if (!this.selected || !this.selected.signed) throw new Error('選定的證券帳戶不存在或未簽署');
    const fingerprint = createHash('sha256').update(JSON.stringify({ ...this.selectors(), simulation: this.info.simulation, origin: this.api })).digest('hex');
    const prior = this.store.get<string>('account_fingerprint');
    if (prior && prior !== fingerprint) throw new Error('帳戶或服務模式已變更，請使用新的獨立資料庫');
    this.store.set('account_fingerprint', fingerprint);
    const schema = await this.fetcher(new URL('/openapi.json', this.settings.base_url), {
      redirect: 'error', signal: AbortSignal.any([this.stop.signal, AbortSignal.timeout(10000)]) });
    if (!schema.ok) throw new Error('無法核對已安裝 Shioaji HTTP API');
    const specification = JSON.parse(await boundedText(schema)) as { paths?: Record<string, unknown> };
    for (const path of ['/api/v1/order/trades','/api/v1/order/trade_cache_health','/api/v1/portfolio/position_unit',
      '/api/v1/portfolio/position_detail','/api/v1/stream/data','/api/v1/data/contracts/{code}/info'])
      if (!specification.paths?.[path]) throw new Error('Shioaji 版本缺少必要端點，請更新官方服務');
    const subscription = await this.request('/auth/subscribe_trade', this.selectors()) as { subscribe_trade?: boolean };
    if (subscription.subscribe_trade !== true) throw new Error('委託回報訂閱失敗');
    await this.refreshTrades();
    this.streamTask = this.streamLoop();
  }
  async close(): Promise<void> { this.stop.abort(); await this.streamTask; this.parts.clear(); }
  private invalidate(): void { this.parts.clear(); this.changed.clear(); this.generation++; this.dirty = true; }
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
        this.streamReady = true; this.invalidate(); attempt = 0;
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
    }
    this.parts.set(key, part); this.changed.add(key);
  }
  quotes(_now: Date): Quote[] {
    const result: Quote[] = [];
    for (const key of this.changed) { const q = QuoteSchema.safeParse(this.parts.get(key)); if (q.success) result.push(q.data); }
    this.changed.clear(); return result;
  }
  async subscribe(symbols: string[], wholeLots: boolean): Promise<void> {
    const metadata = await this.instruments(symbols, new Date()), wanted = new Map<string, Record<string, unknown>>();
    for (const symbol of symbols) {
      const instrument = metadata[symbol]; if (!instrument) continue;
      for (const odd of wholeLots ? [true,false] : [true]) for (const quoteType of ['Tick','BidAsk']) {
        const body = { security_type: 'STK', region: 'TW', code: symbol, exchange: instrument.exchange, quote_type: quoteType, intraday_odd: odd };
        wanted.set(`${symbol}:${odd}:${quoteType}`, body);
      }
    }
    for (const [key, body] of wanted) if (!this.subscribed.has(key)) {
      const result = await this.request('/stream/subscribe', body) as { success?: boolean };
      if (result.success !== true) throw new Error('行情訂閱失敗'); this.subscribed.set(key, body);
    }
    // Keep old subscriptions for this process: they may protect an outstanding order after a plan change.
    // The native service is shared; closing this UI must not unsubscribe another client's reports.
  }
  async instruments(symbols: string[], now: Date): Promise<Record<string, Instrument>> {
    const result: Record<string, Instrument> = {};
    for (const symbol of symbols) {
      const cached = this.metadata.get(symbol);
      if (cached && twDay(new Date(cached.verified_at)) === twDay(now)) { result[symbol] = cached; continue; }
      const raw = stockSchema.parse(await this.request(`/data/contracts/${encodeURIComponent(symbol)}/info?region=TW&security_type=STK`));
      if (raw.code !== symbol) throw new Error('商品代碼不符');
      // Source date, not fetch date, controls readiness. Old limits must never authorize an order.
      const sourceDate = /^\d{4}-\d{2}-\d{2}$/.test(raw.update_date) ? raw.update_date : '';
      if (!sourceDate) throw new Error('商品資料日期無法核對');
      const value = InstrumentSchema.parse({ symbol, name: raw.name, exchange: raw.exchange, category: raw.category,
        kind: /^[1-9]\d{3}$/.test(symbol) ? 'STOCK' : symbol.startsWith('00') ? 'ETF' : 'OTHER',
        reference: raw.reference, limit_down: raw.limit_down, limit_up: raw.limit_up,
        suspended: raw.trading_suspended, disposition: raw.disposition_level > 0, attention: raw.attention_flag,
        verified_at: `${sourceDate}T00:00:00+08:00` });
      this.metadata.set(symbol, value); result[symbol] = value;
    }
    return result;
  }
  private async refreshTrades(): Promise<void> {
    const values = z.array(nativeTradeSchema).parse(await this.request('/order/trades', { ...this.selectors(), refresh: true }));
    if (values.some(t => t.order.account.broker_id !== this.selected?.broker_id || t.order.account.account_id !== this.selected?.account_id))
      throw new Error('委託回傳帳戶不符');
    this.trades = values;
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
    if (!reservePrice || d(reservePrice).lte(0)) throw new Error('外部市價委託缺少資金預留參考價');
    // Unknown/unsupported external orders freeze new orders while still reserving cash/inventory.
    const supported = native.order_cond === 'Cash' && ['Common','IntradayOdd'].includes(native.order_lot);
    return OrderSchema.parse({ local_id: 'external-' + native.id, broker_id: native.id,
      tag: createHash('sha256').update(native.id).digest('hex').slice(0,6), symbol: trade.contract.code,
      action, shares: quantity, limit_price: reservePrice, lot: factor === 1000 ? 'COMMON' : 'ODD',
      status: supported ? mapped : 'UNKNOWN', filled, created_at: new Date(status.order_ts * 1000).toISOString(),
      plan_id: 'external', purpose: 'EXTERNAL' });
  }
  async reconcile(orders: Order[]): Promise<Order[]> {
    await this.refreshTrades();
    return orders.map(local => {
      const matches = this.trades.filter(t => local.broker_id ? t.order.id === local.broker_id : t.order.custom_field === local.tag);
      if (matches.length !== 1) return { ...local, status: 'UNKNOWN' as const };
      try { return this.normalizeTrade(matches[0]!, local); } catch { return { ...local, status: 'UNKNOWN' as const }; }
    });
  }
  async account(now: Date): Promise<Account> {
    const start = new Date(), sequence = this.eventSequence;
    await this.refreshTrades();
    const balance = z.object({ acc_balance: number, date: z.string(), errmsg: z.string() }).parse(
      await this.request('/portfolio/account_balance', this.selectors()));
    if (balance.errmsg || balance.date.slice(0,10) !== twDay(now)) throw new Error('交割戶餘額日期或查詢狀態異常');
    const rows = z.array(z.object({ amount: number, date: z.string(), T: z.number().int() })).parse(
      await this.request('/portfolio/settlements', this.selectors()));
    let debits = d(0), credits = d(0), issue = '';
    for (const r of rows) {
      if (r.T < 0 || d(r.amount).eq(0)) continue;
      if (this.settings.settlement_debit_sign === 'unverified') { issue = '尚未核對交割款正負號'; continue; }
      const debit = this.settings.settlement_debit_sign === 'positive' ? d(r.amount).gt(0) : d(r.amount).lt(0);
      if (debit) debits = debits.plus(d(r.amount).abs()); else credits = credits.plus(d(r.amount).abs());
    }
    const positions = z.array(positionSchema).parse(await this.request('/portfolio/position_unit', { ...this.selectors(), unit: 'Share' }));
    const cleanPositions = [];
    for (const p of positions) {
      const details = z.array(detailSchema).parse(await this.request('/portfolio/position_detail', { ...this.selectors(), detail_id: p.id }));
      cleanPositions.push({ symbol: p.code, shares: p.quantity, sellable: sellableInventory(p.quantity,p.yd_quantity,details,twDay(now)),
        average_price: p.price, last_price: p.last_price });
    }
    await this.instruments([...new Set(this.trades.filter(t => d(t.order.price).lte(0)).map(t => t.contract.code))], now);
    const orders = this.trades.map(t => this.normalizeTrade(t));
    const buys = orders.filter(o => o.action === 'BUY' && twDay(new Date(o.created_at)) === twDay(now) && (active(o) || o.filled > 0));
    const health = z.object({ state: z.string(), reasons: z.array(z.object({ reason: z.string() })) }).parse(
      await this.request('/order/trade_cache_health', this.selectors()));
    if (health.state === 'Degraded' || health.reasons.some(r => r.reason !== 'NoBaseline')) issue = '委託回報尚未完成核對';
    if (!this.streamReady || this.formatFault) issue = '行情串流中斷或格式異常，禁止新增委託';
    if (sequence !== this.eventSequence) issue = '快照取得期間有委託變動，等待重新核對';
    this.dirty = false;
    this.lastAccount = AccountSchema.parse({ asof: start.toISOString(), cash: balance.acc_balance, settlement_debits: debits.toFixed(),
      settlement_credits: credits.toFixed(), positions: cleanPositions, orders, complete: !issue, issue,
      daily_buy_count: buys.length, daily_buy_amount: buys.reduce((sum,o) => sum.plus(d(o.limit_price).times(active(o) ? o.shares : o.filled)),d(0)).toFixed() });
    return this.lastAccount;
  }
  async discover(countRequested: number, now: Date): Promise<Candidate[]> {
    const collected = new Map<string, Candidate>();
    for (const scannerType of ['AmountRank','VolumeRank','ChangePercentRank']) {
      const raw = z.array(z.object({ code: z.string(), name: z.string(), close: number, total_amount: number })).parse(
        await this.request('/data/scanner', { scanner_type: scannerType, ascending: false, count: Math.min(200,countRequested * 2) }));
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
    const raw = historicalKbars(await this.request('/data/kbars', { contract: { security_type:'STK',exchange:m.exchange,code:symbol },
      start:addDays(twDay(now),-150), end:addDays(twDay(now),-1) }),symbol);
    const grouped = new Map<string, Bar>();
    for (const row of raw) {
      const day = twDay(new Date(row.at)); if (day >= twDay(now)) continue;
      const b = grouped.get(day), high = Number(row.high), low = Number(row.low), close = Number(row.close), volume = row.volume_shares;
      grouped.set(day, { date: day, high: b ? Math.max(b.high,high) : high, low: b ? Math.min(b.low,low) : low,
        close, volume: (b?.volume ?? 0) + volume });
    }
    return [...grouped.values()].sort((a,b) => a.date.localeCompare(b.date));
  }
  private async mutationReady(): Promise<void> {
    if (!this.production || !this.allowLive || process.env.LIVE_TRADING !== 'true') throw new NoSubmissionError('實盤下單尚未在本機啟用');
    const consent = this.store.get<{ at: string; fingerprint: string }>('live_consent');
    if (!consent || consent.fingerprint !== this.store.get('account_fingerprint')) throw new NoSubmissionError('缺少本機實盤授權');
    const info = infoSchema.parse(await this.request('/info'));
    if (info.simulation) throw new NoSubmissionError('服務切換成模擬模式，禁止實盤');
    if (info.agent_harness?.enabled || info.agent_harness?.audience) throw new NoSubmissionError('官方服務需要可信任主機能力票證；本版禁止繞過 Agent Harness');
    const health = healthSchema.parse(await this.request('/health'));
    if (health.token_stale || health.ca_expired !== false || !health.ca_expires_in_days || health.ca_expires_in_days <= 0)
      throw new NoSubmissionError('登入或 CA 狀態未確認，禁止下單');
    if (!this.streamReady || this.formatFault) throw new NoSubmissionError('行情連線未完成核對');
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
    try { await this.mutationReady(); await this.refreshTrades(); }
    catch { throw new NoSubmissionError('撤單前連線或授權核對失敗，未送出撤單'); }
    const trade = this.trades.find(t => t.order.id === o.broker_id); if (!trade) throw new Error('撤單前查不到委託');
    const current = this.normalizeTrade(trade,o); if (!active(current)) return current;
    const result = nativeTradeSchema.parse(await this.request('/order/cancel_order',{ trade_id:o.broker_id }));
    return this.normalizeTrade(result,{ ...o,status:'CANCEL_PENDING' });
  }
}
