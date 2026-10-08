from __future__ import annotations

import os
import queue
import threading
from datetime import datetime, time
from pathlib import Path

from .brokers.paper import PaperBroker
from .calendar import TradingCalendar
from .calendar_seed import seed
from .codex import CodexRunner
from .engine import Engine
from .facts import collect_facts
from .models import Settings, TAIPEI, now_tw
from .storage import Store
from .strategy import demo_plan, indicators


def make_engine(store: Store, settings: Settings) -> Engine:
    seed(store)
    calendar = TradingCalendar(store, demo=settings.mode == "demo")
    if settings.mode == "demo":
        broker = PaperBroker(store, settings)
    else:
        from .brokers.shioaji import ShioajiBroker
        if settings.mode == "live":
            if os.environ.get("LIVE_TRADING", "").lower() != "true":
                raise RuntimeError("實盤尚未啟用：需要本機 LIVE_TRADING=true")
            if not store.get("live_consent") or not store.get("readonly_verified"):
                raise RuntimeError("請先完成唯讀核對，再使用本機 enable-live 指令")
        market = ShioajiBroker(store, settings, live=settings.mode == "live")
        broker = PaperBroker(store, settings, market, namespace="realfeed") if settings.mode == "paper" else market
    return Engine(store, broker, settings, calendar)


class Service:
    def __init__(self, store: Store):
        self.store = store
        self.settings = store.settings()
        self.engine = make_engine(store, self.settings)
        self.commands: queue.Queue = queue.Queue()
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.analysis_thread: threading.Thread | None = None
        self.analysis_busy = threading.Event()
        self.runner = CodexRunner()
        self.scheduler = None
        self.text = "正在啟動…"
        self.state_lock = threading.Lock()
        self.analysis_state = "尚未執行"
        self.started = threading.Event()
        self.start_error = ""
        self.fallback_slots: set[str] = set()
        self.last_publish = 0.0

    def start(self):
        self.thread = threading.Thread(target=self._run, name="trading-engine", daemon=True)
        self.thread.start()

    def post(self, command, value=None):
        self.commands.put((command, value))

    def stop(self):
        self.stop_event.set()
        self.runner.stop()
        if self.scheduler:
            self.scheduler.shutdown(wait=False)
        if self.thread:
            self.thread.join(timeout=25)
        if self.analysis_thread:
            self.analysis_thread.join(timeout=2)

    def status(self):
        with self.state_lock:
            return self.text

    def _run(self):
        from .runtime import RuntimeLock, awake
        runtime_lock = RuntimeLock(self.store.path)
        try:
            runtime_lock.acquire()
            awake(self.settings.keep_awake)
            self.engine.start(now_tw())
            self._schedule()
        except Exception as exc:
            self.start_error = "啟動失敗（"+type(exc).__name__+"）；請執行 doctor 並檢查本機設定"
            with self.state_lock:
                self.text = self.start_error
            self.started.set()
            try:
                self.engine.close()
            except Exception:
                pass
            awake(False)
            runtime_lock.release()
            return
        self.started.set()
        try:
            while not self.stop_event.is_set():
                now = now_tw()
                try:
                    for _ in range(20):
                        try:
                            command, value = self.commands.get_nowait()
                        except queue.Empty:
                            break
                        self._command(command, value, now)
                    self.engine.tick(now_tw())
                    if self.scheduler is None:
                        self._fallback_schedule(now)
                except Exception as exc:
                    self.engine.entry_blocked = True
                    if self.engine.account:
                        self.engine.account.complete = False
                    self.engine.log_once("ERROR", type(exc).__name__+"；停止新交易，等待帳戶與行情核對")
                if now.timestamp()-self.last_publish >= 1:
                    upcoming = self._next_jobs()
                    text = self.engine.status(now_tw())+"\n\nCodex："+self.analysis_state
                    text += "\n下次排程："+upcoming
                    text += "\n\n最近事件：\n"+"\n".join(self.engine.messages[-15:])
                    with self.state_lock:
                        self.text = text
                    self.last_publish = now.timestamp()
                self.stop_event.wait(.5)
        finally:
            try:
                self.engine.close()
            except Exception:
                pass
            awake(False)
            runtime_lock.release()

    def _command(self, command, value, now):
        if command == "decision":
            self._request_analysis(review=bool(value))
        elif command == "market_ready":
            bundle, review, settings = value
            try:
                self.engine.reconcile(now)
                self.engine.refresh_account(now)
                snapshot = self.engine.snapshot_from_bundle(bundle, now_tw(), review)
                self.commands.put(("start_codex", (snapshot, settings)))
            except Exception as exc:
                self.commands.put(("analysis_failed", "快照核對失敗（"+type(exc).__name__+"）"))
        elif command == "start_codex":
            snapshot, settings = value
            self.analysis_thread = threading.Thread(target=self._analyze,
                                                    args=(snapshot, settings), daemon=True)
            self.analysis_thread.start()
        elif command == "analysis_ready":
            analysis, snapshot = value
            try:
                self.engine.activate(analysis, snapshot, now)
                self.analysis_state = "完成；已啟用計畫"
            except Exception as exc:
                self.engine.entry_blocked = True
                self.analysis_state = "計畫拒絕："+type(exc).__name__
                self.engine.log("CODEX", "計畫未通過完整性或風險檢查")
            finally:
                self.analysis_busy.clear()
        elif command == "analysis_failed":
            self.engine.entry_blocked = True
            self.analysis_state = value
            self.engine.log("CODEX", value+"；既有有效保護規則持續")
            self.analysis_busy.clear()
        elif command == "pause":
            self.engine.pause_entries(bool(value))
        elif command == "kill":
            self.engine.kill(bool(value))
        elif command == "cancel_owned":
            for order in self.store.orders(active_only=True):
                self.engine.cancel(order.local_id, now)
        elif command == "settings":
            from .runtime import awake
            self.engine.set_settings(value)
            awake(value.keep_awake)
            self.settings = value
            self._schedule()
        elif command == "calendar":
            # Runs in data worker; does not stop quote monitoring while fetching.
            threading.Thread(target=self._refresh_calendar, daemon=True).start()

    def _request_analysis(self, review=False):
        if self.analysis_busy.is_set():
            self.engine.log_once("CODEX", "分析工作仍在執行，略過重疊排程")
            return
        if not self.settings.codex_enabled and self.settings.mode != "demo":
            self.engine.log_once("CODEX", "尚未啟用本機 Codex；不會產生新交易計畫")
            return
        self.analysis_busy.set()
        self.analysis_state = "準備行情與歷史資料"
        settings = self.settings.model_copy(deep=True)
        held = {p.symbol for p in (self.engine.account.positions if self.engine.account else [])}
        self.analysis_thread = threading.Thread(target=self._prepare_market,
                                                args=(settings, held, review), daemon=True)
        self.analysis_thread.start()

    def _prepare_market(self, settings, held, review):
        try:
            now = now_tw()
            pool = self.engine.broker.discover(settings.candidate_pool_size, now)
            symbols = {row["symbol"] for row in pool} | held
            features = {}
            for symbol in sorted(symbols):
                if self.stop_event.is_set():
                    return
                key = f"history_{symbol}_{now.date().isoformat()}"
                bars = self.store.get(key)
                if bars is None:
                    try:
                        bars = self.engine.broker.history(symbol, now)
                        if bars:
                            self.store.set(key, bars)
                    except Exception:
                        bars = []
                features[symbol] = indicators(bars)
            metadata = self.engine.broker.instruments(sorted(symbols), now)
            bundle = {"pool": pool, "features": features, "metadata": metadata}
            if settings.mode != "demo" and settings.official_facts_enabled:
                bundle.update(collect_facts(self.store, symbols, now))
            self.commands.put(("market_ready", (bundle, review, settings)))
        except Exception as exc:
            self.commands.put(("analysis_failed", "資料準備失敗（"+type(exc).__name__+"）"))

    def _analyze(self, snapshot, settings):
        self.analysis_state = "Codex 分析中" if settings.codex_enabled else "虛構流程展示中"
        try:
            if settings.codex_enabled:
                analysis = self.runner.analyze(snapshot, settings)
            else:
                plan = demo_plan(snapshot, settings, now_tw())
                analysis = plan.analysis
                if snapshot["review_only"]:
                    analysis.decisions = []
                    analysis.stance = "HOLD_ONLY"
            self.commands.put(("analysis_ready", (analysis, snapshot)))
        except Exception as exc:
            self.commands.put(("analysis_failed", "Codex 未完成（"+type(exc).__name__+"）"))

    def _refresh_calendar(self):
        try:
            year = now_tw().year
            self.engine.calendar.refresh_twse(year)
            self.store.audit("CALENDAR", f"已更新 {year} 年官方行事曆")
        except Exception:
            self.store.audit("CALENDAR", "官方行事曆更新失敗；保留既有資料，未知日期不送單")

    def _scheduled_request(self, review=False):
        now = now_tw()
        if self.engine.calendar.is_open(now.date()):
            self.post("decision", review)

    def _schedule(self):
        try:
            from apscheduler.schedulers.background import BackgroundScheduler
        except ImportError:
            return
        if self.scheduler:
            self.scheduler.shutdown(wait=False)
        self.scheduler = BackgroundScheduler(timezone=TAIPEI)
        for name, clock, review in [("premarket", self.settings.premarket_time, False),
                                    ("postmarket", self.settings.postmarket_time, True)]:
            hour, minute = map(int, clock.split(":"))
            self.scheduler.add_job(self._scheduled_request, "cron", hour=hour, minute=minute,
                                   id=name, args=[review], coalesce=True, max_instances=1,
                                   misfire_grace_time=60)
        self.scheduler.add_job(self._intraday_request, "interval",
                               minutes=self.settings.decision_interval_minutes,
                               id="intraday", coalesce=True, max_instances=1, misfire_grace_time=60)
        self.scheduler.start()

    def _intraday_request(self):
        if self.engine.calendar.in_session(now_tw()):
            self.post("decision", False)

    def _fallback_schedule(self, now):
        if not self.engine.calendar.is_open(now.date()):
            return
        clock = now.strftime("%H:%M")
        slot = now.strftime("%Y-%m-%d %H:%M")
        if slot in self.fallback_slots:
            return
        elapsed = now.hour*60+now.minute-(9*60+10)
        intraday = self.engine.calendar.in_session(now) and elapsed >= 0 and elapsed % self.settings.decision_interval_minutes == 0
        if clock in {self.settings.premarket_time, self.settings.postmarket_time} or intraday:
            self.fallback_slots.add(slot)
            self.post("decision", clock == self.settings.postmarket_time)

    def _next_jobs(self):
        if self.scheduler:
            return "; ".join(f"{j.id} {j.next_run_time:%m-%d %H:%M}" for j in self.scheduler.get_jobs()
                             if j.next_run_time)
        return f"盤前 {self.settings.premarket_time}／盤中 {self.settings.decision_interval_minutes} 分鐘／盤後 {self.settings.postmarket_time}"
