"""Official 2026 TWSE holiday dates retrieved 2026-10-08. Refresh annually and on changes."""
from datetime import date, timedelta

from .models import SessionDay, TAIPEI
from datetime import datetime

SOURCE = "https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule?response=json&queryYear=115"
CLOSED_2026 = {
    "2026-01-01", "2026-02-12", "2026-02-13", "2026-02-15", "2026-02-16",
    "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-27",
    "2026-02-28", "2026-04-03", "2026-04-04", "2026-04-05", "2026-04-06",
    "2026-05-01", "2026-06-19", "2026-09-25", "2026-09-28", "2026-10-09",
    "2026-10-10", "2026-10-25", "2026-10-26", "2026-12-25"
}


def seed(store):
    if store.session(date(2026, 1, 1)):
        return
    sessions = []
    day = date(2026, 1, 1)
    while day.year == 2026:
        sessions.append(SessionDay(day=day, open=day.weekday()<5 and day.isoformat() not in CLOSED_2026,
                                   source=SOURCE, verified_at=datetime(2026, 10, 8, tzinfo=TAIPEI)))
        day += timedelta(days=1)
    store.save_sessions(sessions)
