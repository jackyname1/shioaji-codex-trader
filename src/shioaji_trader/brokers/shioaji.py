from __future__ import annotations

import contextlib
import io
import re
import threading
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from functools import wraps

from ..credentials import credential
from ..models import Account, Instrument, Order, Position, Quote, Settings, TAIPEI, ZERO
from ..storage import Store


def enum_value(value):
    return str(getattr(value, "value", value))


def serialized(method):
    @wraps(method)
    def wrapped(self, *args, **kwargs):
        with self.api_lock:
            return method(self, *args, **kwargs)
    return wrapped


def dec(value) -> Decimal:
    result = Decimal(str(value))
    if not result.is_finite():
        raise ValueError("nonfinite broker value")
    return result


def event_time(obj) -> datetime:
    value = getattr(obj, "datetime", None)
    if isinstance(value, datetime):
        return value.replace(tzinfo=TAIPEI) if value.tzinfo is None else value.astimezone(TAIPEI)
    day, clock = getattr(obj, "date", None), getattr(obj, "time", None)
    if isinstance(day, tuple):
        day = date(*day)
    elif isinstance(day, str):
        day = date.fromisoformat(day)
    if isinstance(clock, tuple):
        clock = time(*clock)
    elif isinstance(clock, str):
        clock = time.fromisoformat(clock)
    if isinstance(day, date) and isinstance(clock, time):
        return datetime.combine(day, clock, TAIPEI)
    raise ValueError("unrecognized exchange timestamp")


def inventory_sellable(position, details, today: date) -> int:
    """Verify detail quantity units against share-level totals, then exclude today's buys."""
    quantity = int(position.quantity)
    yd = int(position.yd_quantity)
    if not quantity:
        return 0
    if not details:
        raise ValueError("missing lot acquisition details")
    raw_total = sum(int(row.quantity) for row in details)
    if raw_total == quantity:
        factor = 1
    elif raw_total * 1000 == quantity:
        factor = 1000
    else:
        raise ValueError("position detail units or total do not match")
    old = 0
    for row in details:
        if enum_value(row.direction) != "Buy" or enum_value(row.cond) != "Cash":
            raise ValueError("unsupported position detail")
        acquired = date.fromisoformat(str(row.date))
        if acquired > today:
            raise ValueError("future acquisition date")
        if acquired < today:
            old += int(row.quantity)*factor
    return max(0, min(quantity, yd, old))


class ShioajiBroker:
    def __init__(self, store: Store, settings: Settings, live=False, api=None):
        self.store, self.settings = store, settings
        self.production = live
        self.api = api
        self.sj = None
        self.lock = threading.RLock()
        self.api_lock = threading.RLock()
        self.quote_parts: dict[tuple[str, bool], dict] = {}
        self.changed: set[tuple[str, bool]] = set()
        self.subscribed: set[tuple[str, bool]] = set()
        self.trades = {}
        self.order_dirty = threading.Event()
        self.callback_error = False
        self.ca_active = False

    def connect(self):
        if self.api is None:
            import shioaji as sj
            self.sj = sj
            self.api = sj.Shioaji(simulation=False)
            # The SDK may print account identifiers during login; never expose that output.
            with contextlib.redirect_stdout(io.StringIO()):
                self.api.login(api_key=credential("SJ_API_KEY"),
                               secret_key=credential("SJ_SEC_KEY"))
        else:
            import shioaji as sj
            self.sj = sj
        if self.api.stock_account is None:
            raise RuntimeError("找不到證券帳戶")
        self.api.set_on_tick_stk_v1_callback(self._tick)
        self.api.set_on_bidask_stk_v1_callback(self._book)
        self.api.set_order_callback(self._order_event)
        if hasattr(self.api, "subscribe_trade"):
            self.api.subscribe_trade(self.api.stock_account)
        self.api.update_status(self.api.stock_account, timeout=10000)
        if self.production:
            result = self.api.activate_ca(ca_path=credential("SJ_CA_PATH"),
                                          ca_passwd=credential("SJ_CA_PASSWD"),
                                          person_id=self.api.stock_account.person_id)
            if result is not True:
                raise RuntimeError("CA 啟用失敗；禁止實盤交易")
            self.ca_active = True

    @serialized
    def close(self):
        if self.api:
            self.api.logout()

    def _tick(self, exchange, tick):
        try:
            if bool(getattr(tick, "simtrade", False)):
                return
            key = (str(tick.code), bool(tick.intraday_odd))
            stamp = event_time(tick)
            with self.lock:
                parts = self.quote_parts.setdefault(key, {})
                if parts.get("trade_at", stamp) > stamp:
                    return
                parts.update(symbol=key[0], odd=key[1], last=dec(tick.close), trade_at=stamp,
                             simulated=False)
                self.changed.add(key)
        except Exception:
            self.callback_error = True

    def _book(self, exchange, book):
        try:
            if bool(getattr(book, "simtrade", False)):
                return
            key = (str(book.code), bool(book.intraday_odd))
            stamp = event_time(book)
            with self.lock:
                parts = self.quote_parts.setdefault(key, {})
                if parts.get("book_at", stamp) > stamp:
                    return
                multiplier = 1 if key[1] else 1000
                parts.update(bid=dec(book.bid_price[0]), ask=dec(book.ask_price[0]),
                             book_at=stamp, bid_shares=int(book.bid_volume[0])*multiplier,
                             ask_shares=int(book.ask_volume[0])*multiplier)
                self.changed.add(key)
        except Exception:
            self.callback_error = True

    def _order_event(self, state, message):
        # SDK 1.7.6+ maintains Trade automatically. Persist only event identity for dedupe.
        try:
            event_id = message.get("event_id")
            if event_id and not self.store.mark_event(str(event_id)):
                return
            self.order_dirty.set()
        except Exception:
            self.callback_error = True

    def quotes(self, now):
        result = []
        with self.lock:
            changed = list(self.changed)
            self.changed.clear()
            for key in changed:
                parts = dict(self.quote_parts[key])
                if all(field in parts for field in ("last", "trade_at", "book_at", "bid", "ask")):
                    result.append(Quote.model_validate(parts))
        return result

    @serialized
    def subscribe(self, symbols, whole_lots=False):
        desired = {(symbol, True) for symbol in symbols}
        if whole_lots:
            desired |= {(symbol, False) for symbol in symbols}
        for symbol, odd in self.subscribed - desired:
            contract = self.api.contracts.get(symbol)
            for quote_type in [self.sj.QuoteType.Tick, self.sj.QuoteType.BidAsk]:
                self.api.unsubscribe(contract, quote_type=quote_type, intraday_odd=odd)
        for symbol, odd in desired - self.subscribed:
            contract = self.api.contracts.get(symbol)
            if contract is None:
                raise RuntimeError("訂閱商品不存在")
            for quote_type in [self.sj.QuoteType.Tick, self.sj.QuoteType.BidAsk]:
                self.api.subscribe(contract, quote_type=quote_type, intraday_odd=odd)
        self.subscribed = desired

    @serialized
    def instruments(self, symbols, now):
        result = {}
        for symbol in symbols:
            contract = self.api.contracts.get(symbol)
            if contract is None or enum_value(contract.exchange) not in {"TSE", "OTC"}:
                continue
            info = self.api.contracts.info(contract)
            name = str(info.name)
            # Conservative ordinary-stock classification excludes ETF, warrants, special shares.
            kind = "STOCK" if re.fullmatch(r"[1-9]\d{3}", symbol) else "OTHER"
            if symbol.startswith("00"):
                kind = "ETF"
            result[symbol] = Instrument(symbol=symbol, name=name,
                                        exchange=enum_value(contract.exchange),
                                        category=str(info.category), kind=kind,
                                        reference=dec(info.reference), limit_down=dec(info.limit_down),
                                        limit_up=dec(info.limit_up),
                                        suspended=bool(info.trading_suspended),
                                        disposition=int(info.disposition_level) > 0,
                                        attention=bool(info.attention_flag), verified_at=now)
        return result

    @serialized
    def discover(self, count, now):
        # A changing market-wide pool, not a hardcoded watchlist.
        self.api.contracts.list(self.sj.SecurityType.Stock)
        collected = {}
        for ranking in [self.sj.ScannerType.AmountRank, self.sj.ScannerType.VolumeRank,
                        self.sj.ScannerType.ChangePercentRank]:
            for row in self.api.scanners(scanner_type=ranking, count=min(200, count*2),
                                         timeout=10000):
                symbol = str(row.code)
                if not re.fullmatch(r"[1-9]\d{3}", symbol):
                    continue
                timestamp = datetime.fromtimestamp(int(row.ts)/1e9, TAIPEI)
                item = {"symbol": symbol, "name": str(row.name), "last": str(dec(row.close)),
                        "total_amount": str(dec(row.total_amount)),
                        "total_volume": int(row.total_volume), "asof": timestamp.isoformat(),
                        "source": "Shioaji scanner", "ranks": []}
                collected.setdefault(symbol, item)["ranks"].append(enum_value(ranking))
        ordered = sorted(collected.values(), key=lambda item: Decimal(item["total_amount"]),
                         reverse=True)
        symbols = [item["symbol"] for item in ordered]
        metadata = self.instruments(symbols, now)
        eligible = []
        for item in ordered:
            instrument = metadata.get(item["symbol"])
            if (instrument is None or instrument.kind != "STOCK" or instrument.suspended
                    or instrument.disposition or (instrument.attention and not self.settings.allow_attention)):
                continue
            item["category"] = instrument.category
            item["limits"] = [str(instrument.limit_down), str(instrument.limit_up)]
            eligible.append(item)
        return eligible[:count]

    @serialized
    def history(self, symbol, now):
        bars = self.api.kbars(self.api.contracts.get(symbol),
                              start=(now.date()-timedelta(days=120)).isoformat(),
                              end=(now.date()-timedelta(days=1)).isoformat(), timeout=10000)
        grouped = defaultdict(list)
        for i, timestamp in enumerate(bars.ts):
            stamp = datetime.fromtimestamp(int(timestamp)/1e9, TAIPEI)
            if stamp.date() >= now.astimezone(TAIPEI).date():
                continue
            grouped[stamp.date()].append(i)
        daily = []
        for day, indices in sorted(grouped.items()):
            daily.append({"date": day.isoformat(), "open": float(bars.Open[indices[0]]),
                          "high": max(float(bars.High[i]) for i in indices),
                          "low": min(float(bars.Low[i]) for i in indices),
                          "close": float(bars.Close[indices[-1]]),
                          "volume": sum(int(bars.Volume[i]) for i in indices)})
        return daily

    def _account_trades(self):
        return [t for t in self.api.list_trades()
                if t.order.account.account_id == self.api.stock_account.account_id
                and t.order.account.broker_id == self.api.stock_account.broker_id]

    def normalize_trade(self, trade, local: Order | None = None) -> Order:
        native, status = trade.order, trade.status
        lot = enum_value(native.order_lot)
        factor = 1000 if lot in {"Common", "Fixing"} else 1
        native_state = enum_value(status.status)
        states = {"Filled": "FILLED", "Cancelled": "CANCELLED", "PartFilled": "PARTIAL",
                  "Failed": "REJECTED", "Inactive": "REJECTED", "Submitted": "PENDING",
                  "PreSubmitted": "PENDING", "PendingSubmit": "SUBMITTING"}
        state = states.get(native_state, "UNKNOWN")
        quantity = int(getattr(status, "order_quantity", 0) or native.quantity)*factor
        filled = int(status.deal_quantity)*factor
        stamp = status.order_datetime
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=TAIPEI)
        action = {"Buy": "BUY", "Sell": "SELL"}[enum_value(native.action)]
        if local:
            if (local.symbol != trade.contract.code or local.action != action
                    or local.shares != quantity or local.limit_price != dec(native.price)):
                raise ValueError("broker/local order mismatch")
            values = local.model_dump()
            values.update(broker_id=str(native.id or status.id), status=state, filled=filled)
            return Order.model_validate(values)
        # Imported market-price and special-lot orders retain a positive reference for reservations.
        price = dec(native.price)
        if price <= 0:
            price = dec(self.api.contracts.info(trade.contract).limit_up)
        return Order(local_id="external-"+str(native.id or status.id),
                     broker_id=str(native.id or status.id), symbol=str(trade.contract.code),
                     action=action, shares=quantity, limit_price=price,
                     lot="COMMON" if factor == 1000 else "ODD", status=state, filled=filled,
                     created_at=stamp, plan_id="external", purpose="ENTRY" if action == "BUY" else "EXIT")

    @serialized
    def account(self, now):
        started = datetime.now(TAIPEI)
        self.api.update_status(self.api.stock_account, timeout=10000)
        self.order_dirty.clear()
        balance = self.api.account_balance(self.api.stock_account, timeout=10000)
        if getattr(balance, "errmsg", ""):
            raise RuntimeError("交割戶餘額查詢失敗")
        state = enum_value(getattr(balance, "status", "Fetched"))
        if state not in {"Fetched", "Success", "Done"}:
            raise RuntimeError("交割戶餘額未完整取得")
        settlement_rows = self.api.settlements(self.api.stock_account, timeout=10000)
        debits, credits = ZERO, ZERO
        issue = ""
        for row in settlement_rows:
            amount = dec(row.amount)
            if int(row.T) < 0:
                continue
            if amount and self.settings.settlement_debit_sign == "unverified":
                issue = "尚未核對交割款正負號；請先在本機設定並核對券商交割明細"
                continue
            debit = amount > 0 if self.settings.settlement_debit_sign == "positive" else amount < 0
            if debit:
                debits += abs(amount)
            else:
                credits += abs(amount)
        trades = self._account_trades()
        orders = [self.normalize_trade(t) for t in trades]
        self.trades = {str(t.order.id or t.status.id): t for t in trades}
        positions = []
        for p in self.api.list_positions(self.api.stock_account, unit=self.sj.Unit.Share, timeout=10000):
            if enum_value(p.cond) != "Cash" or enum_value(p.direction) != "Buy":
                raise RuntimeError("帳戶含未支援的非現股部位")
            details = self.api.list_position_detail(self.api.stock_account, detail_id=p.id, timeout=10000)
            sellable = inventory_sellable(p, details, now.astimezone(TAIPEI).date())
            positions.append(Position(symbol=str(p.code), shares=int(p.quantity), sellable=sellable,
                                      average_price=dec(p.price), last_price=dec(p.last_price)))
        daily = [o for o in orders if o.action == "BUY"
                 and o.created_at.astimezone(TAIPEI).date() == now.astimezone(TAIPEI).date()
                 and (o.active or o.filled > 0)]
        daily_amount = sum(((o.shares if o.active else o.filled)*o.limit_price for o in daily), ZERO)
        health = self.api.trade_cache_health(self.api.stock_account)
        reasons = [enum_value(r.reason) for r in health.reasons]
        if enum_value(health.state) == "Degraded" or any(r != "NoBaseline" for r in reasons):
            issue = "委託回報尚未完成核對"
        if self.callback_error:
            issue = "行情或委託回報格式異常，請重新連線核對"
        # If a fill occurs during this multi-query snapshot, fail closed and query again.
        if self.order_dirty.is_set():
            issue = "快照取得期間有委託變動，等待重新核對"
        return Account(asof=started, cash=dec(balance.acc_balance), settlement_debits=debits,
                       settlement_credits=credits, positions=positions, orders=orders,
                       complete=not issue, issue=issue, daily_buy_amount=daily_amount,
                       daily_buy_count=len(daily))

    @serialized
    def submit(self, order):
        if not self.production or not self.ca_active:
            raise RuntimeError("唯讀模式禁止送單")
        tag = order.local_id[:6]
        if any(o.local_id != order.local_id and o.local_id[:6] == tag for o in self.store.orders()):
            raise RuntimeError("委託辨識碼碰撞，禁止送出")
        native = self.sj.StockOrder(
            action=self.sj.Action.Buy if order.action == "BUY" else self.sj.Action.Sell,
            price=float(order.limit_price),
            quantity=order.shares if order.lot == "ODD" else order.shares//1000,
            price_type=self.sj.StockPriceType.LMT, order_type=self.sj.OrderType.ROD,
            order_lot=self.sj.StockOrderLot.IntradayOdd if order.lot == "ODD" else self.sj.StockOrderLot.Common,
            order_cond=self.sj.StockOrderCond.Cash, daytrade_short=False,
            custom_field=tag, account=self.api.stock_account)
        trade = self.api.place_order(self.api.contracts.get(order.symbol), native, timeout=10000)
        result = self.normalize_trade(trade, order)
        self.trades[result.broker_id] = trade
        return result

    @serialized
    def cancel(self, order):
        if not self.production or not self.ca_active:
            raise RuntimeError("唯讀模式禁止撤單")
        self.api.update_status(self.api.stock_account, timeout=10000)
        trade = next((t for t in self._account_trades()
                      if str(t.order.id or t.status.id) == order.broker_id), None)
        if trade is None:
            raise RuntimeError("撤單前找不到券商委託")
        current = self.normalize_trade(trade, order)
        if not current.active:
            return current
        self.api.cancel_order(trade, timeout=10000)
        self.api.update_status(self.api.stock_account, timeout=10000)
        return self.normalize_trade(trade, order)

    @serialized
    def reconcile(self, orders):
        self.api.update_status(self.api.stock_account, timeout=10000)
        trades = self._account_trades()
        result = []
        for local in orders:
            matches = [t for t in trades if
                       (local.broker_id and str(t.order.id or t.status.id) == local.broker_id)
                       or (not local.broker_id and t.order.custom_field == local.local_id[:6]
                           and t.status.order_datetime.date() == local.created_at.date())]
            if len(matches) == 1:
                result.append(self.normalize_trade(matches[0], local))
            elif local.status == "PREPARED":
                # PREPARED is persisted before crossing the submit boundary; provably unsent.
                result.append(local.model_copy(update={"status": "REJECTED"}))
            else:
                result.append(local.model_copy(update={"status": "UNKNOWN"}))
        return result
