from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal, ROUND_CEILING

from .calendar import TradingCalendar
from .models import Account, Instrument, Order, Quote, Settings, TAIPEI, ZERO


def tick_size(price: Decimal) -> Decimal:
    for ceiling, tick in [(10, ".01"), (50, ".05"), (100, ".1"),
                          (500, ".5"), (1000, "1")]:
        if price < ceiling:
            return Decimal(tick)
    return Decimal("5")


def aligned_price(price: Decimal) -> bool:
    return price > 0 and price % tick_size(price) == 0


def fee(amount: Decimal, settings: Settings) -> Decimal:
    return max(settings.minimum_fee,
               (amount * settings.fee_rate).quantize(Decimal("1"), rounding=ROUND_CEILING))


@dataclass
class Verdict:
    reasons: list[str] = field(default_factory=list)

    @property
    def allowed(self):
        return not self.reasons


class Risk:
    def __init__(self, settings: Settings, calendar: TradingCalendar):
        self.settings, self.calendar = settings, calendar

    def check(self, order: Order, account: Account, quote: Quote | None,
              instrument: Instrument | None, now: datetime, baseline: Decimal | None,
              paused=False, last_trade: datetime | None = None) -> Verdict:
        s, reasons = self.settings, []
        if paused:
            reasons.append("已暫停新增委託")
        if not account.complete:
            reasons.append("帳戶資料不完整")
        age = (now - account.asof).total_seconds()
        if not 0 <= age <= s.account_max_age:
            reasons.append("帳戶資料過期或時間異常")
        if not self.calendar.in_session(now, order.lot):
            reasons.append("非已確認的交易時段")
        if not instrument or instrument.symbol != order.symbol:
            reasons.append("缺少已確認的商品資料")
        else:
            if instrument.kind != "STOCK" or instrument.exchange not in {"TSE", "OTC"}:
                reasons.append("初版僅允許上市櫃普通股票")
            if instrument.verified_at.astimezone(TAIPEI).date() != now.astimezone(TAIPEI).date():
                reasons.append("商品資料不是今日資料")
            if instrument.suspended or instrument.disposition:
                reasons.append("暫停交易或處置股")
            if instrument.attention and not s.allow_attention and order.action == "BUY":
                reasons.append("注意股禁止新增買進")
            if (instrument.limit_down <= 0 or instrument.limit_up <= 0
                    or not instrument.limit_down <= order.limit_price <= instrument.limit_up):
                reasons.append("價格超出已確認的漲跌停範圍")
        if not aligned_price(order.limit_price):
            reasons.append("價格不符合股票跳動單位")
        if order.lot == "ODD" and not 1 <= order.shares <= 999:
            reasons.append("零股委託必須為 1–999 股")
        if order.lot == "COMMON" and (not s.whole_lots or order.shares % 1000 != 0):
            reasons.append("整股未啟用或股數不符")
        if quote is None or quote.symbol != order.symbol or quote.odd != (order.lot == "ODD"):
            reasons.append("缺少對應市場行情")
        else:
            if quote.simulated:
                reasons.append("試算行情不得當成成交行情")
            if any(not 0 <= (now - timestamp).total_seconds() <= s.quote_max_age
                   for timestamp in (quote.trade_at, quote.book_at)):
                reasons.append("成交或五檔行情過期")
            if quote.bid <= 0 or quote.ask <= 0 or quote.bid > quote.ask:
                reasons.append("買賣報價不完整")
            elif (quote.ask - quote.bid) / quote.last > s.max_spread_fraction:
                reasons.append("零股買賣價差過大")
            if abs(order.limit_price / quote.last - 1) > s.price_deviation_fraction:
                reasons.append("委託價偏離最新成交价")
        active = [o for o in account.orders if o.active and o.local_id != order.local_id]
        if any(o.status in {"UNKNOWN", "SUBMITTING"} for o in active):
            reasons.append("存在尚未核對的委託")
        if any(o.symbol == order.symbol for o in active):
            reasons.append("同標的已有未完成委託")
        if last_trade and order.purpose != "PROTECTION":
            if (now - last_trade).total_seconds() < s.cooldown_seconds:
                reasons.append("標的仍在冷卻時間")
        if order.action == "SELL":
            p = account.position(order.symbol)
            reserved = sum(o.remaining for o in active
                           if o.symbol == order.symbol and o.action == "SELL")
            if p is None or order.shares > p.sellable - reserved:
                reasons.append("可賣股數不足；今日新增零股不可當沖")
            return Verdict(reasons)
        if not s.fee_verified and s.mode == "live":
            reasons.append("尚未確認實際手續費設定")
        equity = account.equity
        if equity <= 0:
            reasons.append("淨資產不明或非正數")
            return Verdict(reasons)
        active_buys = [o for o in active if o.action == "BUY"]
        reserved_cash = sum((o.remaining * o.limit_price
                             + fee(o.remaining * o.limit_price, s) for o in active_buys), ZERO)
        available = account.cash - account.settlement_debits - reserved_cash
        amount = order.shares * order.limit_price
        cost = amount + fee(amount, s)
        if cost > available:
            reasons.append("資金不足，已扣除交割款及掛單占用")
        if available - cost < equity * s.min_cash_fraction:
            reasons.append("買進後現金保留不足")
        investable = max(ZERO, equity * (1 - s.min_cash_fraction))
        if amount > investable * s.max_order_fraction:
            reasons.append("超過單筆投入上限")
        position = account.position(order.symbol)
        current = position.shares * position.last_price if position else ZERO
        name_reserve = sum((o.remaining * o.limit_price for o in active_buys
                            if o.symbol == order.symbol), ZERO)
        if current + name_reserve + amount > equity * s.max_symbol_fraction:
            reasons.append("超過單一標的上限")
        buy_exposure = sum((o.remaining * o.limit_price for o in active_buys), ZERO)
        if account.market_value + buy_exposure + amount > equity * s.max_exposure_fraction:
            reasons.append("超過總持倉上限")
        if account.daily_buy_amount + amount > equity * s.max_daily_buy_fraction:
            reasons.append("超過單日新增買進金額")
        if account.daily_buy_count >= s.max_daily_buy_orders:
            reasons.append("超過單日新增買進筆數")
        if baseline is None or baseline <= 0:
            reasons.append("缺少今日風控基準")
        elif equity <= baseline * (1 - s.daily_loss_fraction):
            reasons.append("達到日損失限制，停止新增買進")
        return Verdict(reasons)
