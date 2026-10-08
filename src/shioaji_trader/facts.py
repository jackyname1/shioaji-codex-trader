"""Optional official monthly revenue and material disclosures, fetched locally without keys."""
from __future__ import annotations

import csv
import io
import json
from datetime import datetime
from urllib.request import Request, urlopen

from .storage import Store

SOURCES = {
    "revenue_listed": "https://openapi.twse.com.tw/v1/opendata/t187ap05_L",
    "revenue_otc": "https://mopsfin.twse.com.tw/opendata/t187ap05_O.csv",
    "disclosures_listed": "https://openapi.twse.com.tw/v1/opendata/t187ap04_L",
    "disclosures_otc": "https://mopsfin.twse.com.tw/opendata/t187ap04_O.csv",
}


def fetch_rows(url: str) -> list[dict]:
    request = Request(url, headers={"User-Agent": "ShioajiCodexTrader/0.1"})
    with urlopen(request, timeout=10) as response:
        raw = response.read(10_000_001)
    if len(raw) > 10_000_000:
        raise ValueError("official dataset too large")
    for encoding in ("utf-8-sig", "cp950"):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise ValueError("unrecognized dataset encoding")
    if url.endswith(".csv"):
        rows = list(csv.DictReader(io.StringIO(text)))
    else:
        rows = json.loads(text)
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ValueError("official dataset schema changed")
    return [{str(k).strip(): str(v).strip() for k, v in row.items()} for row in rows]


def collect_facts(store: Store, symbols: set[str], now: datetime) -> dict:
    fundamentals, disclosures, limitations = {}, [], []
    for name, url in SOURCES.items():
        cache_key = "official_"+name+"_"+now.date().isoformat()
        cached = store.get(cache_key)
        ttl = 3600 if name.startswith("revenue") else 900
        if cached and (now-datetime.fromisoformat(cached["at"])).total_seconds() < ttl:
            rows = cached["rows"]
            fetched = cached["at"]
        else:
            try:
                rows = fetch_rows(url)
                fetched = now.isoformat()
                store.set(cache_key, {"at": fetched, "rows": rows})
            except Exception:
                limitations.append(name+"：官方來源無法取得，本次不使用")
                continue
        for row in rows:
            symbol = row.get("公司代號", "")
            if symbol not in symbols:
                continue
            if name.startswith("revenue"):
                needed = ["資料年月", "營業收入-當月營收", "營業收入-去年同月增減(%)"]
                if not all(key in row for key in needed):
                    limitations.append(symbol+"：月營收欄位不完整")
                    continue
                fundamentals[symbol] = {"source": url, "retrieved_at": fetched,
                                        "data": {key: value[:1000] for key, value in row.items()
                                                 if key in needed + ["出表日期", "產業別",
                                                                     "營業收入-上月比較增減(%)",
                                                                     "累計營業收入-前期比較增減(%)"]}}
            else:
                if not row.get("主旨") or not row.get("發言日期"):
                    continue
                disclosures.append({"symbol": symbol, "source": url, "retrieved_at": fetched,
                                    "published_date": row["發言日期"],
                                    "published_time": row.get("發言時間", ""),
                                    "title": row["主旨"][:600], "description": row.get("說明", "")[:1500]})
    return {"fundamentals": fundamentals, "announcements": disclosures[:60],
            "limitations": limitations}
