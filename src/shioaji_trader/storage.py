from __future__ import annotations

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import date
from pathlib import Path

from .models import Order, Plan, Protection, SessionDay, Settings, now_tw


def data_directory() -> Path:
    base = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local" / "share"))
    return base / "ShioajiCodexTrader"


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False, timeout=10)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS orders(
                local_id TEXT PRIMARY KEY, broker_id TEXT, symbol TEXT, status TEXT,
                payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS protection(symbol TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sessions(day TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS audit(
                id INTEGER PRIMARY KEY, at TEXT, kind TEXT, message TEXT);
            CREATE TABLE IF NOT EXISTS events(event_id TEXT PRIMARY KEY);
        """)
        self.db.commit()

    @contextmanager
    def transaction(self):
        with self.lock:
            try:
                yield self.db
                self.db.commit()
            except BaseException:
                self.db.rollback()
                raise

    def get(self, key: str, default=None):
        with self.lock:
            row = self.db.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set(self, key: str, value):
        with self.transaction() as db:
            db.execute("INSERT OR REPLACE INTO kv VALUES(?,?)",
                       (key, json.dumps(value, ensure_ascii=False, allow_nan=False)))

    def settings(self) -> Settings:
        return Settings.model_validate(self.get("settings", {}))

    def save_settings(self, settings: Settings):
        self.set("settings", settings.model_dump(mode="json"))

    def save_plan(self, plan: Plan):
        # One atomic transaction; the engine never observes a half-written plan.
        self.set("active_plan", plan.model_dump(mode="json"))

    def activate_plan(self, plan: Plan, protections: list[Protection]):
        with self.transaction() as db:
            db.execute("INSERT OR REPLACE INTO kv VALUES(?,?)",
                       ("active_plan", plan.model_dump_json()))
            for protection in protections:
                db.execute("INSERT OR REPLACE INTO protection VALUES(?,?)",
                           (protection.symbol, protection.model_dump_json()))

    def plan(self) -> Plan | None:
        value = self.get("active_plan")
        return Plan.model_validate(value) if value else None

    def insert_intent(self, order: Order) -> bool:
        with self.transaction() as db:
            try:
                db.execute("INSERT INTO orders VALUES(?,?,?,?,?)",
                           (order.local_id, order.broker_id, order.symbol,
                            order.status, order.model_dump_json()))
                return True
            except sqlite3.IntegrityError:
                return False

    def save_order(self, order: Order):
        with self.transaction() as db:
            db.execute("INSERT OR REPLACE INTO orders VALUES(?,?,?,?,?)",
                       (order.local_id, order.broker_id, order.symbol,
                        order.status, order.model_dump_json()))

    def orders(self, active_only=False) -> list[Order]:
        with self.lock:
            rows = self.db.execute("SELECT payload FROM orders").fetchall()
        result = [Order.model_validate_json(row[0]) for row in rows]
        return [o for o in result if o.active] if active_only else result

    def protections(self) -> list[Protection]:
        with self.lock:
            rows = self.db.execute("SELECT payload FROM protection").fetchall()
        return [Protection.model_validate_json(row[0]) for row in rows]

    def save_protection(self, protection: Protection):
        with self.transaction() as db:
            db.execute("INSERT OR REPLACE INTO protection VALUES(?,?)",
                       (protection.symbol, protection.model_dump_json()))

    def remove_protection(self, symbol: str):
        with self.transaction() as db:
            db.execute("DELETE FROM protection WHERE symbol=?", (symbol,))

    def audit(self, kind: str, message: str):
        # Callers supply a controlled message, never exception repr or raw SDK payloads.
        with self.transaction() as db:
            db.execute("INSERT INTO audit(at,kind,message) VALUES(?,?,?)",
                       (now_tw().isoformat(), kind, message[:4000]))

    def recent_audit(self, limit=100):
        with self.lock:
            rows = self.db.execute(
                "SELECT at,kind,message FROM audit ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
        return list(reversed(rows))

    def mark_event(self, event_id: str) -> bool:
        with self.transaction() as db:
            try:
                db.execute("INSERT INTO events VALUES(?)", (event_id,))
                return True
            except sqlite3.IntegrityError:
                return False

    def save_sessions(self, sessions: list[SessionDay]):
        with self.transaction() as db:
            db.executemany("INSERT OR REPLACE INTO sessions VALUES(?,?)",
                           [(s.day.isoformat(), s.model_dump_json()) for s in sessions])

    def session(self, day: date) -> SessionDay | None:
        with self.lock:
            row = self.db.execute("SELECT payload FROM sessions WHERE day=?",
                                  (day.isoformat(),)).fetchone()
        return SessionDay.model_validate_json(row[0]) if row else None

    def close(self):
        with self.lock:
            self.db.close()
