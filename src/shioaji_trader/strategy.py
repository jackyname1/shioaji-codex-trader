from __future__ import annotations

import statistics
from datetime import datetime, timedelta
from decimal import Decimal
from uuid import uuid4

from .models import Analysis, Decision, Plan, Settings, SmartSpec
from .risk import tick_size


def indicators(bars: list[dict]) -> dict:
    if len(bars) < 20:
        return {"sufficient": False, "sessions": len(bars)}
    closes = [float(b["close"]) for b in bars]
    volumes = [float(b["volume"]) for b in bars]
    result = {"sufficient": True, "sessions": len(bars), "asof": bars[-1]["date"]}
    for period in [5, 20, 60]:
        if len(closes) >= period:
            result[f"ma{period}"] = statistics.mean(closes[-period:])
    changes = [closes[i]-closes[i-1] for i in range(len(closes)-14, len(closes))]
    up = statistics.mean(max(0, change) for change in changes)
    down = statistics.mean(max(0, -change) for change in changes)
    result["rsi14"] = 100-100/(1+up/down) if down else (100 if up else 50)
    ranges = [max(float(bars[i]["high"])-float(bars[i]["low"]),
                  abs(float(bars[i]["high"])-closes[i-1]),
                  abs(float(bars[i]["low"])-closes[i-1]))
              for i in range(len(bars)-14, len(bars))]
    result["atr14"] = statistics.mean(ranges)
    result["support20"] = min(float(b["low"]) for b in bars[-20:])
    result["resistance20"] = max(float(b["high"]) for b in bars[-20:])
    result["volume_ratio20"] = volumes[-1]/statistics.mean(volumes[-20:]) if sum(volumes[-20:]) else 0
    result["return20"] = closes[-1]/closes[-20]-1 if closes[-20] else 0
    return result


def validate_analysis(analysis: Analysis, snapshot: dict, now: datetime, settings: Settings) -> Plan:
    if analysis.snapshot_id != snapshot["snapshot_id"]:
        raise ValueError("Codex 使用的快照不符")
    asof = datetime.fromisoformat(snapshot["asof"])
    if asof.tzinfo is None or not 0 <= (now-asof).total_seconds() <= settings.codex_timeout_seconds+30:
        raise ValueError("Codex 決策資料已過期")
    if not now < analysis.expires_at <= now + timedelta(minutes=settings.plan_max_minutes):
        raise ValueError("計畫有效期限不符")
    universe = {item["symbol"] for item in snapshot["universe"]}
    held = {item["symbol"] for item in snapshot["account"]["positions"]}
    if not set(analysis.candidates) <= universe:
        raise ValueError("候選包含資料範圍以外的股票")
    if len(universe) >= 5 and len(analysis.candidates) < 5:
        raise ValueError("候選須列出至少 5 檔；可以全部觀望")
    for decision in analysis.decisions:
        if decision.symbol not in set(analysis.candidates) | held:
            raise ValueError("決策標的不在候選或持倉內")
        if decision.action == "BUY" and decision.symbol not in analysis.candidates:
            raise ValueError("買進標的必須在候選內")
        if decision.action == "BUY" and not snapshot["features"].get(decision.symbol, {}).get("sufficient"):
            raise ValueError("買進標的缺少足夠歷史資料")
    return Plan(id=uuid4().hex, created_at=now, analysis=analysis)


def demo_plan(snapshot: dict, settings: Settings, now: datetime) -> Plan:
    if not snapshot.get("synthetic"):
        raise ValueError("範例策略只能使用虛構行情")
    candidates = [item["symbol"] for item in snapshot["universe"][:5]]
    decisions = []
    if candidates:
        price = Decimal(snapshot["universe"][0]["last"])
        step = tick_size(price)
        stop = ((price*Decimal("0.95"))/step).to_integral_value()*step
        take = ((price*Decimal("1.10"))/step).to_integral_value()*step
        decisions.append(Decision(symbol=candidates[0], action="BUY", shares=10,
                                  limit_price=price+step, entry_when="IMMEDIATE", trigger_price=0,
                                  smart=SmartSpec(stop_price=stop, take_profit=take,
                                                  trailing_activate=take,
                                                  trailing_fraction=Decimal("0.03")),
                                  reason="虛構行情流程展示，並非投資策略或真實股票建議"))
    analysis = Analysis(snapshot_id=snapshot["snapshot_id"],
                        expires_at=now+timedelta(minutes=settings.plan_max_minutes),
                        stance="BUY_ALLOWED", candidates=candidates, decisions=decisions,
                        summary="DEMO：驗證定時決策、委託、部分成交及跨日庫存流程")
    return validate_analysis(analysis, snapshot, now, settings)
