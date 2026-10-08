from __future__ import annotations

import hashlib
from datetime import datetime
from decimal import Decimal
from uuid import uuid4

from .calendar import TradingCalendar
from .models import Account, Analysis, Decision, Order, Plan, Settings, TAIPEI, ZERO, now_tw
from .risk import Risk, aligned_price
from .smart import evaluate, update_protection
from .storage import Store
from .strategy import indicators, validate_analysis


class Engine:
    """Single-writer trading engine. GUI, scheduler and Codex send commands, never broker calls."""
    def __init__(self, store: Store, broker, settings: Settings, calendar: TradingCalendar):
        self.store, self.broker, self.settings, self.calendar = store, broker, settings, calendar
        self.risk = Risk(settings, calendar)
        self.plan = store.plan()
        self.quote_cache = {}
        self.metadata = {}
        self.account: Account | None = None
        self.paused_entries = bool(store.get("paused_entries", False))
        self.killed = bool(store.get("kill_switch", False))
        self.last_account_refresh: datetime | None = None
        self.last_reconcile: datetime | None = None
        self.last_tick: datetime | None = None
        self.connected = False
        self.entry_blocked = False
        self.messages = []
        self.pool = []
        self.history_cache = {}
        self.reprice_attempts = {}

    def log(self, kind, text):
        self.store.audit(kind, text)
        self.messages.append(f"{kind}: {text}")
        self.messages = self.messages[-100:]

    def start(self, now: datetime):
        self.broker.connect()
        self.connected = True
        self.reconcile(now)
        self.refresh_account(now)
        self.update_subscriptions(now)
        self.log("START", f"模式={self.settings.mode}；自動執行={self.settings.auto_execute}")

    def close(self):
        self.broker.close()
        self.connected = False

    def set_settings(self, settings):
        if settings.mode != self.settings.mode or settings.whole_lots != self.settings.whole_lots:
            raise ValueError("交易模式與整股設定變更後，請重新啟動程式")
        self.settings = settings
        self.broker.settings = settings
        if hasattr(self.broker, "market") and hasattr(self.broker.market, "settings"):
            self.broker.market.settings = settings
        self.risk = Risk(settings, self.calendar)
        self.store.save_settings(settings)

    def refresh_account(self, now):
        account = self.broker.account(now)
        if self.broker.production:
            now = now_tw()
        # Merge durable intents and backend orders by broker identity, including external orders.
        locals_ = self.store.orders(active_only=True)
        by_broker = {o.broker_id: o for o in locals_ if o.broker_id}
        merged = [by_broker.get(o.broker_id, o) for o in account.orders]
        known = {o.local_id for o in merged}
        merged.extend(o for o in locals_ if o.local_id not in known)
        account.orders = merged
        self.account = account
        self.last_account_refresh = now
        key = "baseline_"+now.astimezone(TAIPEI).date().isoformat()
        if account.complete and self.store.get(key) is None:
            self.store.set(key, {"equity": str(account.equity), "at": now.isoformat()})
            self.log("BASELINE", "建立本交易日首次有效快照基準；不是歷史開盤資產")
        if account.issue:
            self.log_once("ACCOUNT", account.issue)
        return account

    def baseline(self, now):
        item = self.store.get("baseline_"+now.astimezone(TAIPEI).date().isoformat())
        return Decimal(item["equity"]) if item else None

    def log_once(self, kind, text):
        message = f"{kind}: {text}"
        if message not in self.messages[-20:]:
            self.log(kind, text)

    def reconcile(self, now):
        for order in self.broker.reconcile(self.store.orders(active_only=True)):
            self.store.save_order(order)
        self.last_reconcile = now
        if any(o.status == "UNKNOWN" for o in self.store.orders(active_only=True)):
            self.log_once("BLOCK", "有不明委託，停止新委託；需核對券商結果，不會盲目重送")

    def update_subscriptions(self, now):
        symbols = {p.symbol for p in self.store.protections()}
        if self.account:
            symbols |= {p.symbol for p in self.account.positions}
        symbols |= {o.symbol for o in self.store.orders(active_only=True)}
        if self.plan:
            symbols |= set(self.plan.analysis.candidates)
            symbols |= {d.symbol for d in self.plan.analysis.decisions}
        self.broker.subscribe(sorted(symbols), self.settings.whole_lots)
        self.metadata = self.broker.instruments(sorted(symbols), now)

    def snapshot(self, now, review=False):
        self.reconcile(now)
        account = self.refresh_account(now)
        if not account.complete:
            raise RuntimeError("帳戶快照未完整取得，暫停新決策")
        self.pool = self.broker.discover(self.settings.candidate_pool_size, now)
        symbols = {row["symbol"] for row in self.pool} | {p.symbol for p in account.positions}
        features = {}
        for symbol in sorted(symbols):
            key = (symbol, now.astimezone(TAIPEI).date().isoformat())
            if key not in self.history_cache:
                try:
                    self.history_cache[key] = self.broker.history(symbol, now)
                except Exception:
                    self.history_cache[key] = []
            features[symbol] = indicators(self.history_cache[key])
        self.metadata.update(self.broker.instruments(sorted(symbols), now))
        return self.snapshot_from_bundle({"pool": self.pool, "features": features}, now, review)

    def snapshot_from_bundle(self, bundle, now, review=False):
        account = self.account
        if not account or not account.complete:
            raise RuntimeError("帳戶快照不完整")
        self.pool = bundle["pool"]
        features = bundle["features"]
        self.metadata.update(bundle.get("metadata", {}))
        if self.settings.mode != "demo":
            try:
                previous = self.calendar.previous_session(now.astimezone(TAIPEI).date()).isoformat()
            except ValueError:
                previous = "9999-12-31"
            for feature in features.values():
                if feature.get("asof", "") < previous:
                    feature["sufficient"] = False
                    feature["issue"] = "歷史行情過期或交易日未知"
        protections = {p.symbol: p.spec.model_dump(mode="json") for p in self.store.protections()}
        # Account and order IDs, credentials, CA paths, raw SDK data are deliberately excluded.
        clean_account = {
            "cash": str(account.cash), "settlement_debits": str(account.settlement_debits),
            "settlement_credits": str(account.settlement_credits), "equity": str(account.equity),
            "daily_buy_amount": str(account.daily_buy_amount), "daily_buy_count": account.daily_buy_count,
            "positions": [p.model_dump(mode="json") for p in account.positions],
            "open_orders": [{"symbol": o.symbol, "action": o.action, "shares": o.remaining,
                             "limit_price": str(o.limit_price)} for o in account.orders if o.active],
        }
        hard_limits = {name: getattr(self.settings, name) for name in [
            "whole_lots", "min_cash_fraction", "max_order_fraction", "max_symbol_fraction",
            "max_exposure_fraction", "max_daily_buy_fraction", "max_daily_buy_orders",
            "daily_loss_fraction", "price_deviation_fraction", "minimum_fee", "fee_rate",
            "sell_tax_rate", "plan_max_minutes"]}
        hard_limits = {k: str(v) if isinstance(v, Decimal) else v for k, v in hard_limits.items()}
        return {"snapshot_id": uuid4().hex, "asof": now.isoformat(),
                "synthetic": self.settings.mode == "demo", "review_only": review,
                "account": clean_account, "universe": self.pool, "features": features,
                "hard_limits": hard_limits, "existing_protection": protections,
                "fundamentals": bundle.get("fundamentals", {}), "news": bundle.get("announcements", []),
                "data_limitations": bundle.get("limitations", []) + [
                                     "重大訊息為公司公告；沒有完整新聞、財報、估值資料時不得編造",
                                     "日損失基準為本日第一次有效帳戶快照；盤中啟動無法回推開盤資產"]}

    def activate(self, analysis: Analysis, snapshot: dict, now: datetime):
        if snapshot.get("review_only") and any(d.action != "HOLD" for d in analysis.decisions):
            raise ValueError("盤後檢討不得產生交易委託")
        plan = validate_analysis(analysis, snapshot, now, self.settings)
        existing = {p.symbol: p for p in self.store.protections()}
        protection = []
        for decision in plan.analysis.decisions:
            if decision.smart:
                protection.append(update_protection(existing.get(decision.symbol), decision.symbol,
                                                    decision.smart, plan.id))
        # A newly accepted plan invalidates unsent entry conditions. Cancel only owned old entry orders.
        if self.can_execute():
            for order in self.store.orders(active_only=True):
                if order.purpose == "ENTRY" and order.plan_id != plan.id:
                    self.cancel(order.local_id, now)
        self.store.activate_plan(plan, protection)
        self.plan = plan
        self.entry_blocked = False
        self.update_subscriptions(now)
        self.log("PLAN", f"啟用計畫 {plan.id[:8]}，有效至 {analysis.expires_at.isoformat()}")

    def can_execute(self):
        return (self.settings.auto_execute and self.settings.mode != "readonly"
                and not self.killed and self.connected)

    def pause_entries(self, paused=True):
        self.paused_entries = paused
        self.store.set("paused_entries", paused)
        self.log("PAUSE", "停止新增買進；保護監控持續" if paused else "恢復新增買進")

    def kill(self, enabled=True):
        self.killed = enabled
        self.store.set("kill_switch", enabled)
        self.log("KILL", "停止全部新委託；現有掛單仍需撤單" if enabled else "解除停止委託")

    def tick(self, now: datetime):
        if not self.connected:
            return
        if self.last_tick and (now-self.last_tick).total_seconds() > 45:
            self.quote_cache.clear()
            self.log("RESUME", "偵測休眠或長時間停頓；清除行情並重新核對")
            self.reconcile(now)
            self.refresh_account(now)
            self.update_subscriptions(now)
        self.last_tick = now
        if not self.last_reconcile or (now-self.last_reconcile).total_seconds() >= 15:
            self.reconcile(now)
        if (not self.last_account_refresh or (now-self.last_account_refresh).total_seconds() >= 20
                or getattr(self.broker, "order_dirty", None) and self.broker.order_dirty.is_set()):
            self.reconcile(now)
            self.refresh_account(now)
        for quote in self.broker.quotes(now):
            self.quote_cache[(quote.symbol, quote.odd)] = quote
        if self.settings.mode in {"demo", "paper"}:
            self.reconcile(now)
            self.refresh_account(now)
        if not self.account:
            return
        if self.plan and now >= self.plan.analysis.expires_at and self.can_execute():
            for order in self.store.orders(active_only=True):
                if order.purpose == "ENTRY":
                    self.cancel(order.local_id, now)
        # Protective rules are durable and keep working after Codex timeout or entry-plan expiry.
        for protection in self.store.protections():
            position = self.account.position(protection.symbol)
            pending_buy = any(o.active and o.symbol == protection.symbol and o.action == "BUY"
                              for o in self.account.orders)
            planned_buy = (self.plan and now < self.plan.analysis.expires_at and
                           any(d.symbol == protection.symbol and d.action == "BUY"
                               for d in self.plan.analysis.decisions))
            if position is None or not position.shares:
                if not pending_buy and not planned_buy:
                    self.store.remove_protection(protection.symbol)
                continue
            quote = self.quote_cache.get((protection.symbol, True))
            if not quote or not 0 <= (now-quote.trade_at).total_seconds() <= self.settings.quote_max_age:
                continue
            trigger = evaluate(protection, quote.last)
            self.store.save_protection(protection)
            if not trigger:
                continue
            if not position.sellable:
                self.log_once("WAIT", f"{position.symbol} {trigger} 已觸發，今日買進量尚不可賣；下個交易日重評")
                continue
            if not self.can_execute():
                continue
            pending = next((o for o in self.store.orders(active_only=True)
                            if o.symbol == position.symbol), None)
            if pending:
                if pending.action == "BUY":
                    self.cancel(pending.local_id, now)
                elif pending.purpose == "PROTECTION":
                    self.reprice_protection(pending, quote.bid, now)
                continue
            attempts = len([o for o in self.store.orders() if o.symbol == position.symbol
                            and o.purpose == "PROTECTION"
                            and o.created_at.astimezone(TAIPEI).date() == now.astimezone(TAIPEI).date()])
            if attempts >= 10:
                self.log_once("BLOCK", f"{position.symbol} 保護出場重試達上限，請核對委託")
                continue
            order = Order(local_id=uuid4().hex, symbol=position.symbol, action="SELL",
                          shares=min(999, position.sellable), limit_price=quote.bid,
                          created_at=now, plan_id=protection.plan_id, purpose="PROTECTION")
            self.submit(order, now)
        if not self.can_execute() or not self.plan or now >= self.plan.analysis.expires_at:
            return
        for decision in self.plan.analysis.decisions:
            if decision.action == "HOLD":
                continue
            if decision.action == "BUY" and (self.entry_blocked or self.paused_entries):
                continue
            lot = "COMMON" if decision.shares >= 1000 else "ODD"
            quote = self.quote_cache.get((decision.symbol, lot == "ODD"))
            if not quote:
                continue
            if decision.entry_when == "BELOW" and quote.last > decision.trigger_price:
                continue
            if decision.entry_when == "ABOVE" and quote.last < decision.trigger_price:
                continue
            if decision.action == "BUY" and decision.smart and quote.ask <= decision.smart.stop_price:
                self.log_once("BLOCK", f"{decision.symbol} 價格已跌破進場計畫停損，等待新計畫")
                continue
            local_id = hashlib.sha256(f"{self.plan.id}:{decision.symbol}:{decision.action}".encode()).hexdigest()[:32]
            if any(o.local_id == local_id for o in self.store.orders()):
                continue
            order = Order(local_id=local_id, symbol=decision.symbol, action=decision.action,
                          shares=decision.shares, limit_price=decision.limit_price, lot=lot,
                          created_at=now, plan_id=self.plan.id,
                          purpose="ENTRY" if decision.action == "BUY" else "EXIT")
            self.submit(order, now)

    def submit(self, order: Order, now):
        if not self.can_execute():
            return False
        self.reconcile(now)
        account = self.refresh_account(now)
        if self.broker.production:
            now = now_tw()
        last = max((o.created_at for o in self.store.orders() if o.symbol == order.symbol
                    and (o.active or o.filled)), default=None)
        quote = self.quote_cache.get((order.symbol, order.lot == "ODD"))
        verdict = self.risk.check(order, account, quote, self.metadata.get(order.symbol), now,
                                  self.baseline(now),
                                  paused=self.killed or (self.paused_entries and order.action == "BUY"),
                                  last_trade=last)
        if not verdict.allowed:
            self.log_once("RISK", f"{order.symbol} {order.action}："+"；".join(verdict.reasons))
            return False
        if not self.store.insert_intent(order):
            return False
        order.status = "SUBMITTING"
        self.store.save_order(order)  # Durable write BEFORE touching the network.
        try:
            result = self.broker.submit(order)
            self.store.save_order(result)
            self.log("ORDER", f"{order.symbol} {order.action} {order.shares} 股 @ {order.limit_price} {result.status}")
        except Exception:
            order.status = "UNKNOWN"
            self.store.save_order(order)
            self.log("UNKNOWN", f"{order.symbol} 送單結果不明；先核對，禁止自動重送")
            return False
        self.refresh_account(now)
        return True

    def cancel(self, local_id, now):
        if self.settings.mode == "readonly" or self.killed and not self.connected:
            raise RuntimeError("目前模式無法撤單")
        order = next((o for o in self.store.orders(active_only=True) if o.local_id == local_id), None)
        if not order:
            return
        if order.status == "UNKNOWN":
            self.log_once("BLOCK", "不明委託須先核對，不能直接撤單或重掛")
            return
        order.status = "CANCEL_PENDING"
        self.store.save_order(order)
        try:
            result = self.broker.cancel(order)
            self.store.save_order(result)
            self.log("CANCEL", f"{order.symbol} 撤單核對：{result.status}，已成交 {result.filled} 股")
        except Exception:
            order.status = "UNKNOWN"
            self.store.save_order(order)
            self.log("UNKNOWN", f"{order.symbol} 撤單結果不明，停止重掛")
        self.refresh_account(now)

    def reprice_protection(self, order, bid: Decimal, now):
        if (bid <= 0 or bid == order.limit_price or not aligned_price(bid)
                or (now-order.created_at).total_seconds() < 60):
            return
        self.cancel(order.local_id, now)
        # The next tick creates a replacement ONLY after confirmed cancellation and inventory refresh.

    def status(self, now):
        a = self.account
        lines = [f"Shioaji Codex Trader | {self.settings.mode.upper()} | {now.astimezone(TAIPEI):%Y-%m-%d %H:%M:%S}",
                 f"連線={self.connected} 自動執行={self.settings.auto_execute} 暫停買進={self.paused_entries} 緊急停止={self.killed}",
                 "DEMO 使用虛構股票及行情" if self.settings.mode == "demo" else "所有數量單位：股；今日買進零股不得當沖"]
        if a:
            lines += [f"現金={a.cash:,.0f} 待付交割={a.settlement_debits:,.0f} 淨資產={a.equity:,.0f}",
                      f"帳戶快照={a.asof.isoformat()} 完整={a.complete} {a.issue}",
                      f"今日買進預算占用={a.daily_buy_amount:,.0f} 筆數={a.daily_buy_count}", "", "持倉："]
            lines += [f"{p.symbol} {p.shares} 股 / 可賣 {p.sellable} / 成本 {p.average_price:.2f} / 現價 {p.last_price}"
                      for p in a.positions] or ["無"]
        if self.plan:
            lines += ["", f"計畫 {self.plan.id[:8]} 到期 {self.plan.analysis.expires_at.isoformat()}",
                      self.plan.analysis.summary, "候選："+", ".join(self.plan.analysis.candidates)]
            lines += [f"{d.symbol} {d.action} {d.shares} 股 @ {d.limit_price}：{d.reason}"
                      for d in self.plan.analysis.decisions]
        lines += ["", "保護條件："]
        lines += [f"{p.symbol} 停損={p.spec.stop_price} 停利={p.spec.take_profit} 高點={p.high_water} 訊號={p.triggered or '-'}"
                  for p in self.store.protections()]
        lines += ["", "未完成委託："]
        lines += [f"{o.local_id[:8]} {o.symbol} {o.action} {o.filled}/{o.shares} 股 @ {o.limit_price} {o.status}"
                  for o in self.store.orders(active_only=True)] or ["無"]
        return "\n".join(lines)
