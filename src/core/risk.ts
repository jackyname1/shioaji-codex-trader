import { Decimal } from 'decimal.js';
import { active, ageSeconds, d, equity, marketValue, remaining, twDay,
  type Account, type Instrument, type Order, type Quote, type Settings } from './models.js';
import { TradingCalendar } from './calendar.js';
import {authorizedRisk} from './risk-policy.js';
import {orderBudget} from './capital.js';
import {fee} from './costs.js';
import {lotQuantityIssues} from './stock-lot.js';
export {fee} from './costs.js';

export function tickSize(price: Decimal.Value): Decimal {
  const p = d(price);
  for (const [ceiling, tick] of [[10, '.01'], [50, '.05'], [100, '.1'], [500, '.5'], [1000, '1']] as const)
    if (p.lt(ceiling)) return d(tick);
  return d(5);
}
export const alignedPrice = (price: Decimal.Value): boolean => d(price).gt(0) && d(price).mod(tickSize(price)).eq(0);
export const roundPrice = (price: Decimal.Value, down = true): string => {
  const tick = tickSize(price), units = d(price).div(tick);
  return (down ? units.floor() : units.ceil()).times(tick).toFixed();
};
export class Risk {
  readonly settings:Settings;
  constructor(settings: Settings, readonly calendar: TradingCalendar) {this.settings=authorizedRisk(settings);}
  check(order: Order, account: Account, quote: Quote | undefined, instrument: Instrument | undefined,
    now: Date, baseline?: string, paused = false, lastTrade?: string): string[] {
    const s = this.settings, reasons: string[] = [];
    if (paused) reasons.push('已暫停新增委託');
    if (!account.complete) reasons.push('帳戶資料不完整');
    const age = ageSeconds(now, account.asof);
    if (!(age >= 0 && age <= s.account_max_age)) reasons.push('帳戶資料過期或時間異常');
    if (!this.calendar.inSession(now, order.lot)) reasons.push('非已確認的交易時段');
    if (!instrument || instrument.symbol !== order.symbol) reasons.push('缺少已確認的商品資料');
    else {
      if (instrument.kind !== 'STOCK') reasons.push('僅允許上市櫃普通股票');
      if (twDay(new Date(instrument.verified_at)) !== twDay(now)) reasons.push('商品資料不是今日資料');
      if (instrument.suspended || instrument.disposition) reasons.push('暫停交易或處置股');
      if (instrument.attention && !s.allow_attention && order.action === 'BUY') reasons.push('注意股禁止新增買進');
      if (d(instrument.limit_down).lte(0) || d(instrument.limit_up).lte(0)
        || d(order.limit_price).lt(instrument.limit_down) || d(order.limit_price).gt(instrument.limit_up))
        reasons.push('價格超出已確認的漲跌停範圍');
    }
    if (!alignedPrice(order.limit_price)) reasons.push('價格不符合股票跳動單位');
    reasons.push(...lotQuantityIssues(order.lot,order.shares));
    if (order.lot === 'COMMON' && !s.whole_lots) reasons.push('整股尚未啟用');
    if (!quote || quote.symbol !== order.symbol || quote.odd !== (order.lot === 'ODD')) reasons.push('缺少對應市場行情');
    else {
      if (quote.simulated) reasons.push('試算行情不得當成成交行情');
      if ([quote.trade_at, quote.book_at].some(t => !(ageSeconds(now, t) >= 0 && ageSeconds(now, t) <= s.quote_max_age)))
        reasons.push('成交或五檔行情過期');
      if (d(quote.bid).lte(0) || d(quote.ask).lte(0) || d(quote.bid).gt(quote.ask)) reasons.push('買賣報價不完整');
      else if (d(quote.ask).minus(quote.bid).div(quote.last).gt(s.max_spread_fraction)) reasons.push('零股買賣價差過大');
      if (d(order.limit_price).div(quote.last).minus(1).abs().gt(s.price_deviation_fraction)) reasons.push('委託價偏離最新成交價');
      if((order.action==='BUY'?quote.ask_shares:quote.bid_shares)<=0)reasons.push('對手方無有效可成交深度，等待新報價');
    }
    const others = account.orders.filter(o => active(o) && o.local_id !== order.local_id);
    if (others.some(o => ['PREPARED','UNKNOWN','SUBMITTING'].includes(o.status))) reasons.push('存在尚未核對的委託');
    if (others.some(o => o.symbol === order.symbol)) reasons.push('同標的已有未完成委託');
    if (lastTrade && order.purpose !== 'PROTECTION' && ageSeconds(now, lastTrade) < s.cooldown_seconds)
      reasons.push('標的仍在冷卻時間');
    if (order.action === 'SELL') {
      const p = account.positions.find(p => p.symbol === order.symbol);
      const reserved = others.filter(o => o.symbol === order.symbol && o.action === 'SELL').reduce((sum, o) => sum + remaining(o), 0);
      if (!p || order.shares > p.sellable - reserved) reasons.push('可賣股數不足；今日新增零股不可當沖');
      return reasons;
    }
    const e = equity(account);
    if (e.lte(0)) return [...reasons, '淨資產不明或非正數'];
    const buys = others.filter(o => o.action === 'BUY');
    const reserved = buys.reduce((sum, o) => { const amount = d(o.limit_price).times(remaining(o));
      return sum.plus(amount).plus(fee(amount, s)); }, d(0));
    const available = d(account.cash).minus(account.settlement_debits).minus(reserved);
    const amount = d(order.limit_price).times(order.shares), cost = amount.plus(fee(amount, s));
    if (cost.gt(available)) reasons.push('資金不足，已扣除交割款及掛單占用');
    if (available.minus(cost).lt(e.times(s.min_cash_fraction))) reasons.push('買進後現金保留不足');
    if (amount.gt(orderBudget(e,s))) reasons.push('超過單筆投入上限');
    const p = account.positions.find(p => p.symbol === order.symbol);
    const held = p ? d(p.last_price).times(p.shares) : d(0);
    const symbolReserved = buys.filter(o => o.symbol === order.symbol).reduce((sum, o) => sum.plus(d(o.limit_price).times(remaining(o))), d(0));
    if (held.plus(symbolReserved).plus(amount).gt(e.times(s.max_symbol_fraction))) reasons.push('超過單一標的上限');
    // A legacy oversized holding or standing buy in another symbol must not be
    // ignored when admitting new risk. Existing shares are never force-sold here.
    for(const symbol of new Set([...account.positions.map(p=>p.symbol),...buys.map(o=>o.symbol)])){
      if(symbol===order.symbol)continue;
      const position=account.positions.find(p=>p.symbol===symbol);
      const value=(position?d(position.last_price).times(position.shares):d(0)).plus(
        buys.filter(o=>o.symbol===symbol).reduce((sum,o)=>sum.plus(d(o.limit_price).times(remaining(o))),d(0)));
      if(value.gt(e.times(s.max_symbol_fraction)))reasons.push(`既有 ${symbol} 超過單一標的上限，停止新增風險`);
    }
    const exposure = buys.reduce((sum, o) => sum.plus(d(o.limit_price).times(remaining(o))), marketValue(account));
    if (exposure.plus(amount).gt(e.times(s.max_exposure_fraction))) reasons.push('超過總持倉上限');
    const todayBuys=account.orders.filter(o=>o.local_id!==order.local_id&&o.action==='BUY'&&twDay(new Date(o.created_at))===twDay(now)&&(active(o)||o.filled>0));
    const committed=Decimal.max(account.daily_buy_amount,todayBuys.reduce((v,o)=>v.plus(d(o.limit_price).times(active(o)?o.shares:o.filled)),d(0)));
    if (committed.plus(amount).gt(e.times(s.max_daily_buy_fraction))) reasons.push('超過單日新增買進金額');
    if (Math.max(account.daily_buy_count,todayBuys.length) >= s.max_daily_buy_orders) reasons.push('超過單日新增買進筆數');
    if (!baseline || d(baseline).lte(0)) reasons.push('缺少今日風控基準');
    else if (e.lte(d(baseline).times(d(1).minus(s.daily_loss_fraction)))) reasons.push('達到日損失限制，停止新增買進');
    return reasons;
  }
}
