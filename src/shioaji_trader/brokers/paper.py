from __future__ import annotations

import math
from datetime import datetime, timedelta
from decimal import Decimal

from ..models import Account, Instrument, Order, Position, Quote, Settings, TAIPEI, ZERO
from ..risk import fee, tick_size
from ..storage import Store


class DemoMarket:
    """Synthetic, explicitly labelled feed. Never uses fabricated real-symbol prices."""
    production = False

    def __init__(self):
        self.symbols = [str(9000 + i) for i in range(1, 31)]
        self.watched: set[str] = set()

    def connect(self):
        pass

    def close(self):
        pass

    def instruments(self, symbols, now):
        return {s: Instrument(symbol=s, name=f"DEMO-{s}（虛構）", exchange="TSE",
                              reference=Decimal("100"), limit_down=Decimal("10"),
                              limit_up=Decimal("1000"), verified_at=now)
                for s in symbols if s in self.symbols}

    def discover(self, count, now):
        return [{"symbol": s, "name": f"DEMO-{s}（虛構）", "source": "synthetic",
                 "asof": now.isoformat(), "amount_rank": i + 1,
                 "last": str(self.price(s, now)), "category": "DEMO"}
                for i, s in enumerate(self.symbols[:count])]

    @staticmethod
    def price(symbol, now):
        base = Decimal(40 + (int(symbol) % 30) * 5)
        change = Decimal(str(math.sin(now.timestamp() / 180 + int(symbol)) * 0.5))
        price = base + change
        step = tick_size(price)
        return (price / step).to_integral_value() * step

    def history(self, symbol, now):
        today = now.astimezone(TAIPEI).date()
        records = []
        for i in range(120, 0, -1):
            day = today - timedelta(days=i)
            if day.weekday() >= 5:
                continue
            value = float(self.price(symbol, now)) * (1 - i * .0002)
            records.append({"date": day.isoformat(), "open": value, "high": value * 1.01,
                            "low": value * .99, "close": value, "volume": 100000})
        return records

    def subscribe(self, symbols, whole_lots=False):
        self.watched = set(symbols)

    def quotes(self, now):
        result = []
        for symbol in sorted(self.watched):
            value = self.price(symbol, now)
            step = tick_size(value)
            result.append(Quote(symbol=symbol, last=value, bid=value-step, ask=value+step,
                                trade_at=now, book_at=now, bid_shares=17, ask_shares=17))
        return result


class PaperBroker:
    production = False

    def __init__(self, store: Store, settings: Settings, market=None, namespace="demo"):
        self.store, self.settings = store, settings
        self.market = market or DemoMarket()
        self.key = f"paper_ledger_{namespace}"
        self.ledger = store.get(self.key, {
            "cash": str(settings.demo_cash), "lots": [], "orders": [], "fills": []
        })
        self.latest: dict[tuple[str, bool], Quote] = {}
        self.consumed: set[tuple[str, str]] = set()

    def save(self):
        self.store.set(self.key, self.ledger)

    def connect(self):
        self.market.connect()

    def close(self):
        self.market.close()

    def instruments(self, symbols, now):
        return self.market.instruments(symbols, now)

    def discover(self, count, now):
        return self.market.discover(count, now)

    def history(self, symbol, now):
        return self.market.history(symbol, now)

    def subscribe(self, symbols, whole_lots=False):
        self.market.subscribe(symbols, whole_lots)

    def quotes(self, now):
        quotes = self.market.quotes(now)
        for quote in quotes:
            self.latest[(quote.symbol, quote.odd)] = quote
            self.match(quote, now)
        return quotes

    def account(self, now):
        day = now.astimezone(TAIPEI).date().isoformat()
        positions = []
        for symbol in sorted({lot["symbol"] for lot in self.ledger["lots"]}):
            lots = [lot for lot in self.ledger["lots"] if lot["symbol"] == symbol and lot["shares"]]
            shares = sum(lot["shares"] for lot in lots)
            if not shares:
                continue
            cost = sum((Decimal(lot["price"]) * lot["shares"] for lot in lots), ZERO)
            quote = self.latest.get((symbol, True))
            positions.append(Position(symbol=symbol, shares=shares,
                                      sellable=sum(lot["shares"] for lot in lots if lot["day"] < day),
                                      average_price=cost/shares,
                                      last_price=quote.last if quote else cost/shares))
        orders = [Order.model_validate(o) for o in self.ledger["orders"]]
        daily_orders = [o for o in orders if o.action == "BUY"
                        and o.created_at.astimezone(TAIPEI).date().isoformat() == day
                        and (o.active or o.filled > 0)]
        daily_amount = sum((Decimal(f["amount"]) for f in self.ledger["fills"]
                            if f["day"] == day and f["action"] == "BUY"), ZERO)
        daily_amount += sum((o.remaining * o.limit_price for o in daily_orders if o.active), ZERO)
        return Account(asof=now, cash=Decimal(self.ledger["cash"]), positions=positions,
                       orders=orders, daily_buy_amount=daily_amount,
                       daily_buy_count=len(daily_orders))

    def submit(self, order):
        if any(o["local_id"] == order.local_id for o in self.ledger["orders"]):
            raise RuntimeError("duplicate paper intent")
        accepted = order.model_copy(update={"status": "PENDING", "broker_id": "paper-"+order.local_id})
        self.ledger["orders"].append(accepted.model_dump(mode="json"))
        self.save()
        return accepted

    def cancel(self, order):
        for i, item in enumerate(self.ledger["orders"]):
            if item["local_id"] == order.local_id:
                current = Order.model_validate(item)
                if current.active:
                    current.status = "CANCELLED"
                    self.ledger["orders"][i] = current.model_dump(mode="json")
                    self.save()
                return current
        raise RuntimeError("unknown paper order")

    def reconcile(self, orders):
        known = {o["local_id"]: Order.model_validate(o) for o in self.ledger["orders"]}
        result = []
        for order in orders:
            if order.local_id in known:
                result.append(known[order.local_id])
            elif order.status == "PREPARED":
                result.append(order.model_copy(update={"status": "REJECTED"}))
            else:
                result.append(order.model_copy(update={"status": "UNKNOWN"}))
        return result

    def match(self, quote, now):
        if quote.simulated or (now - quote.trade_at).total_seconds() > self.settings.quote_max_age:
            return
        changed = False
        for index, item in enumerate(self.ledger["orders"]):
            order = Order.model_validate(item)
            if not order.active or order.symbol != quote.symbol or quote.odd != (order.lot == "ODD"):
                continue
            if quote.trade_at < order.created_at:
                continue
            if order.created_at.astimezone(TAIPEI).date() != now.astimezone(TAIPEI).date():
                order.status = "CANCELLED"
                self.ledger["orders"][index] = order.model_dump(mode="json")
                changed = True
                continue
            event = (order.local_id, quote.trade_at.isoformat())
            if event in self.consumed:
                continue
            price = quote.ask if order.action == "BUY" else quote.bid
            if price <= 0 or (order.action == "BUY" and price > order.limit_price):
                continue
            if order.action == "SELL" and price < order.limit_price:
                continue
            self.consumed.add(event)
            shares = min(order.remaining, quote.ask_shares if order.action == "BUY" else quote.bid_shares)
            if order.lot == "COMMON":
                shares = shares // 1000 * 1000
            if not shares:
                continue
            day = now.astimezone(TAIPEI).date().isoformat()
            if order.action == "BUY":
                amount = shares * price
                # Conservative paper fee per fill; real fee policies may aggregate fills.
                cost = amount + fee(amount, self.settings)
                if Decimal(self.ledger["cash"]) < cost:
                    continue
                self.ledger["cash"] = str(Decimal(self.ledger["cash"]) - cost)
                self.ledger["lots"].append({"symbol": order.symbol, "shares": shares,
                                            "price": str(price), "day": day})
            else:
                sellable = sum(lot["shares"] for lot in self.ledger["lots"]
                               if lot["symbol"] == order.symbol and lot["day"] < day)
                shares = min(shares, sellable)
                if not shares:
                    continue
                remaining = shares
                for lot in self.ledger["lots"]:
                    if lot["symbol"] != order.symbol or lot["day"] >= day:
                        continue
                    take = min(remaining, lot["shares"])
                    lot["shares"] -= take
                    remaining -= take
                amount = shares * price
                proceeds = amount - fee(amount, self.settings) - amount*self.settings.sell_tax_rate
                self.ledger["cash"] = str(Decimal(self.ledger["cash"]) + proceeds)
            self.ledger["fills"].append({"action": order.action, "amount": str(amount),
                                          "shares": shares, "day": day})
            order.filled += shares
            order.status = "FILLED" if not order.remaining else "PARTIAL"
            self.ledger["orders"][index] = order.model_dump(mode="json")
            changed = True
        if changed:
            self.save()
