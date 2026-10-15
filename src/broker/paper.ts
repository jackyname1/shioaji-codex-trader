import { Store } from '../core/store.js';
import { TradingCalendar } from '../core/calendar.js';
import { fee, roundPrice, tickSize } from '../core/risk.js';
import { AccountSchema, OrderSchema, active, addDays, d, remaining, twDay,
  type Account, type Bar, type Candidate, type Instrument, type Order, type Quote, type Settings } from '../core/models.js';
import type { Broker } from './types.js';
import {tradeRiskIssues,roundTripEstimate} from '../core/costs.js';

interface Lot { symbol: string; shares: number; price: string; acquired: string; cost?: string }
export interface SimulatedFill { id: string; order_id: string; at: string; symbol: string; action: 'BUY'|'SELL';
  lot: 'ODD'|'COMMON'; purpose: Order['purpose']; shares: number; price: string; amount: string;
  fee: string; tax: string; realized_pnl: string | null;exit_trigger?:string }
export interface FillRiskCheck {fill_id:string;order_id:string;at:string;symbol:string;filled_shares:number;average_fill_price:string;
  buy_fee:string;equity:string;estimated_stop_loss:string|null;issues:string[]}
interface Ledger { cash: string; lots: Lot[]; orders: Order[]; lastEvents: Record<string,string>;
  charges: Record<string,{ amount: string; fee: string; tax: string }>; fills?: SimulatedFill[];
  credits?: {due:string;amount:string}[];risk_checks?:FillRiskCheck[] }
export class SyntheticMarket implements Broker {
  readonly production = false; dirty = false; generation = 0;
  private symbols = Array.from({ length:30 },(_,i) => String(9001 + i));
  private watched = new Set<string>();
  private wholeLots = false;
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async account(_now: Date): Promise<Account> { throw new Error('虛構行情源不提供帳戶'); }
  async reconcile(_orders: Order[]): Promise<Order[]> { return []; }
  async subscribe(symbols: string[], wholeLots: boolean): Promise<void> { symbols.forEach(s => this.watched.add(s)); this.wholeLots = wholeLots; }
  private price(symbol: string, now: Date): string {
    const base = 30 + (Number(symbol) - 9001) * 2;
    return roundPrice(base + Math.sin(now.getTime() / 60000 + Number(symbol)) * base * .004);
  }
  quotes(now: Date): Quote[] {
    return [...this.watched].flatMap(symbol => { const last = this.price(symbol,now), tick = tickSize(last);
      return (this.wholeLots ? [true,false] : [true]).map(odd => ({ symbol,last,bid:d(last).minus(tick).toFixed(),ask:d(last).plus(tick).toFixed(),odd,simulated:false,
        bid_shares:odd ? 17 : 17000,ask_shares:odd ? 17 : 17000,trade_at:now.toISOString(),book_at:now.toISOString() })); });
  }
  async instruments(symbols: string[], now: Date): Promise<Record<string, Instrument>> {
    return Object.fromEntries(symbols.filter(s => this.symbols.includes(s)).map(symbol => [symbol,{
      symbol,name:'虛構股票 ' + symbol,exchange:'TSE',category:'DEMO',kind:'STOCK',
      reference:this.price(symbol,now),limit_down:roundPrice(d(this.price(symbol,now)).times('.9')),
      limit_up:roundPrice(d(this.price(symbol,now)).times('1.1')),suspended:false,disposition:false,attention:false,verified_at:now.toISOString(),
    }]));
  }
  async discover(count: number, now: Date): Promise<Candidate[]> {
    const offset = Math.floor(now.getTime() / 3600000) % this.symbols.length;
    return [...this.symbols.slice(offset),...this.symbols.slice(0,offset)].slice(0,count).map(symbol => ({
      symbol,name:'虛構股票 ' + symbol,last:this.price(symbol,now),amount:'10000000',source:'SYNTHETIC：非真實交易標的',
    }));
  }
  async history(symbol: string, now: Date): Promise<Bar[]> {
    const result: Bar[] = [];
    for (let n = 110; n > 0; n--) {
      const day = addDays(twDay(now),-n), date = new Date(day + 'T04:00:00Z');
      if ([0,6].includes(date.getUTCDay())) continue;
      const close = Number(this.price(symbol,date));
      result.push({date:day,close,high:close * 1.015,low:close * .985,volume:500000 + n * 1000});
    }
    return result;
  }
  async submit(_order: Order): Promise<Order> { throw new Error('虛構行情源不能送單'); }
  async cancel(_order: Order): Promise<Order> { throw new Error('虛構行情源不能撤單'); }
}
export class PaperBroker implements Broker {
  readonly production = false;
  dirty = false; generation = 0;
  private ledger: Ledger;
  private prices = new Map<string,string>();
  private instrumentCache:Record<string,Instrument>={};
  private wholeLots = false;
  constructor(readonly store: Store, readonly market: Broker, public settings: Settings, readonly calendar: TradingCalendar,
    private readonly settleSales = false) {
    this.ledger = store.get<Ledger>('paper_ledger') ?? { cash:settings.demo_cash,lots:[],orders:[],lastEvents:{},charges:{} };
    d(this.ledger.cash); this.ledger.orders.forEach(o => OrderSchema.parse(o));
    this.ledger.fills ??= []; this.ledger.credits ??= [];
    this.ledger.risk_checks??=[];
    for (const lot of this.ledger.lots) if (!Number.isSafeInteger(lot.shares) || lot.shares < 0
      || !/^\d{4}-\d{2}-\d{2}$/.test(lot.acquired)) throw new Error('模擬庫存資料不完整');
  }
  private persist(): void { this.store.set('paper_ledger',this.ledger); }
  async connect(): Promise<void> { await this.market.connect(); }
  async close(): Promise<void> { await this.market.close(); this.persist(); }
  async subscribe(symbols: string[], wholeLots: boolean): Promise<void> { this.wholeLots = wholeLots; await this.market.subscribe(symbols,wholeLots); }
  async instruments(symbols: string[], now: Date): Promise<Record<string, Instrument>> {
    const data=await this.market.instruments(symbols,now);this.instrumentCache={...this.instrumentCache,...data};return data;
  }
  discover(count: number, now: Date): Promise<Candidate[]> { return this.market.discover(count,now); }
  history(symbol: string, now: Date): Promise<Bar[]> { return this.market.history(symbol,now); }
  features(symbol:string,now:Date){return this.market.features?.(symbol,now);}
  quotes(now: Date): Quote[] {
    this.settle(now);
    this.generation = this.market.generation;
    const quotes = this.market.quotes(now);
    this.expire(now);
    for (const q of quotes) {
      if(q.simulated||[q.trade_at,q.book_at].some(at=>Date.parse(at)>now.getTime()))continue;
      this.prices.set(q.symbol,q.last);
      if (!this.calendar.inSession(now,q.odd ? 'ODD' : 'COMMON') || q.simulated) continue;
      if([q.trade_at,q.book_at].some(at=>now.getTime()-Date.parse(at)>this.settings.quote_max_age*1000))continue;
      const key = `${q.symbol}:${q.odd}`, event = q.trade_at + '/' + q.book_at;
      if (this.ledger.lastEvents[key] === event) continue;
      this.ledger.lastEvents[key] = event;
      let bidDepth = q.bid_shares, askDepth = q.ask_shares;
      for (const order of this.ledger.orders.filter(o => active(o) && o.symbol === q.symbol && (o.lot === 'ODD') === q.odd)) {
        if(Math.max(Date.parse(q.trade_at),Date.parse(q.book_at))<=Date.parse(order.created_at))continue;
        if(!(order.action==='BUY'?d(q.ask).gt(0):d(q.bid).gt(0)))continue;
        let candidate=order.action==='BUY'?d(q.ask).times(d(1).plus(this.settings.simulation_slippage_fraction)):
          d(q.bid).times(d(1).minus(this.settings.simulation_slippage_fraction));
        const instrument=this.instrumentCache[q.symbol];
        // Clamp adverse simulated execution to verified exchange bounds, without inventing depth.
        if(instrument&&Date.parse(instrument.verified_at)<=now.getTime()&&twDay(new Date(instrument.verified_at))===twDay(now))
          candidate=order.action==='BUY'?(candidate.gt(instrument.limit_up)?d(instrument.limit_up):candidate):
            (candidate.lt(instrument.limit_down)?d(instrument.limit_down):candidate);
        const price=roundPrice(candidate,order.action!=='BUY');
        if(order.action==='BUY'?d(price).gt(order.limit_price):d(price).lt(order.limit_price))continue;
        let shares = Math.min(remaining(order),order.action === 'BUY' ? askDepth : bidDepth);
        if (order.lot === 'COMMON') shares = Math.floor(shares / 1000) * 1000;
        if (shares <= 0) continue;
        const amount = d(price).times(shares), prior = this.ledger.charges[order.local_id] ?? {amount:'0',fee:'0',tax:'0'};
        const total = d(prior.amount).plus(amount), totalFee = fee(total,this.settings);
        const totalTax = order.action === 'SELL' ? total.times(this.settings.sell_tax_rate).ceil() : d(0);
        const extraFee = totalFee.minus(prior.fee), extraTax = totalTax.minus(prior.tax);
        let realized: string | null = null;
        if (order.action === 'BUY') {
          if (d(this.ledger.cash).lt(amount.plus(extraFee))) continue;
          this.ledger.cash = d(this.ledger.cash).minus(amount).minus(extraFee).toFixed();
          this.ledger.lots.push({symbol:order.symbol,shares,price,acquired:twDay(now),cost:amount.plus(extraFee).toFixed()}); askDepth -= shares;
        } else {
          if (this.sellable(order.symbol,twDay(now)) < shares) continue;
          let needed = shares, cost = d(0);
          for (const lot of this.ledger.lots) if (lot.symbol === order.symbol && lot.acquired < twDay(now)) {
            const used = Math.min(needed,lot.shares); if (!used) continue;
            const basis = d(lot.cost ?? d(lot.price).times(lot.shares).toFixed()), usedCost = basis.times(used).div(lot.shares);
            cost = cost.plus(usedCost); lot.cost = basis.minus(usedCost).toFixed(); lot.shares -= used; needed -= used;
          }
          const proceeds = amount.minus(extraFee).minus(extraTax); realized = proceeds.minus(cost).toFixed();
          if (this.settleSales && proceeds.gte(0)) {
            let due = '9999-12-31'; try { due = this.calendar.next(this.calendar.next(twDay(now))); } catch { /* Do not recycle unverified settlement credits. */ }
            this.ledger.credits!.push({due,amount:proceeds.toFixed()});
          } else this.ledger.cash = d(this.ledger.cash).plus(proceeds).toFixed();
          bidDepth -= shares;
        }
        order.filled += shares; order.status = order.filled === order.shares ? 'FILLED' : 'PARTIAL';
        this.ledger.charges[order.local_id] = { amount:total.toFixed(),fee:totalFee.toFixed(),tax:totalTax.toFixed() };
        const fill: SimulatedFill = {id:`${order.local_id}:${order.filled}`,order_id:order.local_id,
          at:now.toISOString(),symbol:order.symbol,action:order.action,lot:order.lot,purpose:order.purpose,
          shares,price,amount:amount.toFixed(),fee:extraFee.toFixed(),tax:extraTax.toFixed(),realized_pnl:realized,
          ...(order.exit_trigger?{exit_trigger:order.exit_trigger}:{})};
        this.ledger.fills!.push(fill);
        if(order.action==='BUY'){
          const spec=this.store.protections().find(p=>p.symbol===order.symbol)?.spec;
          const average=total.div(order.filled).toFixed();
          const value=this.ledger.lots.reduce((sum,l)=>sum.plus(d(this.prices.get(l.symbol)??l.price).times(l.shares)),d(0))
            .plus(this.ledger.cash).plus(this.ledger.credits!.reduce((sum,c)=>sum.plus(c.amount),d(0)));
          const issues=tradeRiskIssues(order.filled,average,spec,value,this.settings);
          this.ledger.risk_checks!.push({fill_id:fill.id,order_id:order.local_id,at:fill.at,symbol:fill.symbol,filled_shares:order.filled,
            average_fill_price:average,buy_fee:totalFee.toFixed(),equity:value.toFixed(),
            estimated_stop_loss:roundTripEstimate(order.filled,average,null,this.settings,spec?.stop_price??null).estimated_stop_loss,issues});
          if(issues.length)this.store.set('postfill_block_'+twDay(now),{at:fill.at,symbol:fill.symbol,issues});
        }
        const plan=this.store.plan(),reason=plan?.id===order.plan_id?plan.analysis.decisions.find(x=>x.symbol===order.symbol)?.reason:undefined;
        this.store.recordExperience({id:fill.id,at:fill.at,mode:this.store.get<string>('experience_scope') ?? this.settings.mode,
          kind:'SIMULATED_FILL',symbol:fill.symbol,action:fill.action,shares,price,fee:fill.fee,tax:fill.tax,
          realized_pnl:realized,note:`模擬 ${order.purpose} 成交與 FIFO 成本（含買進費用），不代表真實券商成交。原計畫理由：${reason??'持久化智慧保護或之前的計畫'}`});
        this.dirty = true;
      }
    }
    this.ledger.lots = this.ledger.lots.filter(l => l.shares > 0); this.persist();
    return quotes;
  }
  private expire(now: Date): void {
    for (const o of this.ledger.orders) if (active(o) && twDay(new Date(o.created_at)) < twDay(now)) { o.status = 'CANCELLED'; this.dirty = true; }
  }
  private settle(now: Date): void {
    const today = twDay(now), due = this.ledger.credits!.filter(x => x.due <= today);
    this.ledger.cash = due.reduce((sum,x) => sum.plus(x.amount),d(this.ledger.cash)).toFixed();
    this.ledger.credits = this.ledger.credits!.filter(x => x.due > today);
  }
  fillCount():number{return this.ledger.fills!.length;}
  fills(start=0): SimulatedFill[] { return structuredClone(this.ledger.fills!.slice(start)); }
  riskChecks():FillRiskCheck[]{return structuredClone(this.ledger.risk_checks??[]);}
  remainingCost(): string { return this.ledger.lots.reduce((sum,l) => sum.plus(l.cost ?? d(l.price).times(l.shares)),d(0)).toFixed(); }
  costBasis(symbol:string):string|undefined{
    const lots=this.ledger.lots.filter(l=>l.symbol===symbol);
    return lots.length?lots.reduce((sum,l)=>sum.plus(l.cost??d(l.price).times(l.shares)),d(0)).toFixed():undefined;
  }
  private sellable(symbol: string, today: string): number {
    return this.ledger.lots.filter(l => l.symbol === symbol && l.acquired < today).reduce((sum,l) => sum + l.shares,0);
  }
  async account(now: Date): Promise<Account> {
    this.settle(now); this.expire(now); this.persist();
    const positions = [];
    for (const symbol of new Set(this.ledger.lots.map(l => l.symbol))) {
      const lots = this.ledger.lots.filter(l => l.symbol === symbol), shares = lots.reduce((sum,l) => sum + l.shares,0);
      const cost = lots.reduce((sum,l) => sum.plus(d(l.price).times(l.shares)),d(0));
      positions.push({symbol,shares,sellable:this.sellable(symbol,twDay(now)),average_price:cost.div(shares).toFixed(),
        last_price:this.prices.get(symbol) ?? cost.div(shares).toFixed()});
    }
    const buys = this.ledger.orders.filter(o => o.action === 'BUY' && twDay(new Date(o.created_at)) === twDay(now) && (active(o) || o.filled > 0));
    const account = AccountSchema.parse({asof:now.toISOString(),cash:this.ledger.cash,settlement_debits:'0',
      settlement_credits:this.ledger.credits!.reduce((sum,x) => sum.plus(x.amount),d(0)).toFixed(),
      positions,orders:structuredClone(this.ledger.orders),complete:true,
      issue:this.settleSales ? '模擬帳務：買款即時預留、賣款 T+2 可用' : '模擬成交；未模擬實際 T+2 入扣款與券商拒單',
      daily_buy_count:buys.length,daily_buy_amount:buys.reduce((sum,o) => sum.plus(d(o.limit_price).times(active(o) ? o.shares : o.filled)),d(0)).toFixed()});
    this.dirty = false; return account;
  }
  async reconcile(orders: Order[]): Promise<Order[]> {
    return orders.map(local => {
      const found = this.ledger.orders.find(o => o.local_id === local.local_id);
      return found ? structuredClone(found) : { ...local,status:'UNKNOWN' as const };
    });
  }
  async submit(order: Order): Promise<Order> {
    const existing = this.ledger.orders.find(o => o.local_id === order.local_id);
    if (existing) return structuredClone(existing);
    if (order.lot === 'COMMON' && !this.wholeLots) throw new Error('模擬整股未啟用');
    const result = OrderSchema.parse({...order,broker_id:'paper-' + order.local_id,status:'PENDING'});
    this.ledger.orders.push(result); this.persist(); this.dirty = true; return structuredClone(result);
  }
  async cancel(order: Order): Promise<Order> {
    const found = this.ledger.orders.find(o => o.local_id === order.local_id);
    if (!found) throw new Error('模擬委託不存在');
    if (active(found)) found.status = 'CANCELLED';
    this.persist(); this.dirty = true; return structuredClone(found);
  }
}
