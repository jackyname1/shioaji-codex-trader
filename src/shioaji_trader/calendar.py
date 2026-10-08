from __future__ import annotations

import csv
import json
import re
from datetime import date, datetime, time, timedelta
from pathlib import Path
from urllib.request import Request, urlopen

from .models import SessionDay, TAIPEI, now_tw
from .storage import Store


class TradingCalendar:
    def __init__(self, store: Store, demo: bool = False):
        self.store, self.demo = store, demo

    def is_open(self, day: date) -> bool:
        session = self.store.session(day)
        if session:
            return session.open
        # Weekdays alone NEVER authorize production orders.
        return self.demo and day.weekday() < 5

    def in_session(self, moment: datetime, lot="ODD") -> bool:
        local = moment.astimezone(TAIPEI)
        if not self.is_open(local.date()):
            return False
        # Trading rule effective date is explicit, not silently inferred from weekday.
        odd_start = time(9, 0) if local.date() >= date(2026, 12, 7) else time(9, 10)
        start = odd_start if lot == "ODD" else time(9, 0)
        return start <= local.time().replace(tzinfo=None) < time(13, 30)

    def next_session(self, day: date) -> date:
        for offset in range(1, 370):
            candidate = day + timedelta(days=offset)
            if self.is_open(candidate):
                return candidate
        raise ValueError("尚未載入下一個交易日的行事曆")

    def previous_session(self, day: date) -> date:
        for offset in range(1, 370):
            candidate = day - timedelta(days=offset)
            if self.is_open(candidate):
                return candidate
        raise ValueError("尚未載入前一個交易日的行事曆")

    def import_csv(self, path: Path):
        # Explicit daily records avoid treating government make-up workdays as trading days.
        with path.open(encoding="utf-8-sig", newline="") as handle:
            records = list(csv.DictReader(handle))
        sessions = []
        for row in records:
            if row.get("open") not in {"0", "1"} or not row.get("source"):
                raise ValueError("CSV 必須包含 day,open(0/1),source")
            sessions.append(SessionDay(day=date.fromisoformat(row["day"]),
                                       open=row["open"] == "1", source=row["source"],
                                       verified_at=now_tw()))
        if not sessions or len({s.day for s in sessions}) != len(sessions):
            raise ValueError("行事曆空白或包含重複日期")
        self.store.save_sessions(sessions)

    def refresh_twse(self, year: int):
        url = ("https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule"
               f"?response=json&queryYear={year-1911}")
        request = Request(url, headers={"User-Agent": "ShioajiCodexTrader/0.1"})
        with urlopen(request, timeout=15) as response:
            payload = json.loads(response.read(2_000_000).decode("utf-8"))
        sessions = parse_twse_calendar(payload, year, url)
        self.store.save_sessions(sessions)
        return len(sessions)


def parse_twse_calendar(payload: dict, year: int, source: str) -> list[SessionDay]:
    if payload.get("stat", "").lower() != "ok":
        raise ValueError("證交所行事曆回應不完整")
    if str(year - 1911) not in payload.get("title", ""):
        raise ValueError("證交所回傳的年份不符")
    if payload.get("fields", [])[:3] != ["日期", "名稱", "說明"]:
        raise ValueError("證交所行事曆欄位變更，請匯入已核對的每日 CSV")
    closed, explicitly_open = set(), set()
    rows = payload.get("data", [])
    if len(rows) < 8:
        raise ValueError("證交所行事曆資料不足")
    for row in rows:
        if len(row) < 3 or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", row[0]):
            raise ValueError("行事曆日期格式變更")
        day = date.fromisoformat(row[0])
        if day.year != year:
            raise ValueError("行事曆日期年份不符")
        # TWSE lists both closing dates and three named start/end trading days.
        name = row[1]
        if "開始交易日" in name or "最後交易日" in name:
            explicitly_open.add(day)
        else:
            closed.add(day)
    sessions = []
    day = date(year, 1, 1)
    while day.year == year:
        opened = day in explicitly_open or (day.weekday() < 5 and day not in closed)
        sessions.append(SessionDay(day=day, open=opened, source=source, verified_at=now_tw()))
        day += timedelta(days=1)
    return sessions
