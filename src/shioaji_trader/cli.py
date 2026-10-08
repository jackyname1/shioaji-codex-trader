from __future__ import annotations

import argparse
import importlib.util
import json
import os
import time
from datetime import datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory

from .calendar import TradingCalendar
from .calendar_seed import seed
from .credentials import SECRET_NAMES, configure_credentials, credential
from .models import Settings, TAIPEI, now_tw
from .service import Service, make_engine
from .storage import Store, data_directory
from .strategy import demo_plan

LIVE_ACK = "ENABLE CASH STOCK AUTO TRADING"


def doctor(store):
    settings = store.settings()
    checks = []
    for module in ["pydantic", "PySide6", "apscheduler", "keyring", "shioaji"]:
        checks.append(f"{module}: {'可用' if importlib.util.find_spec(module) else '尚未安裝'}")
    from .codex import executable_command
    try:
        executable_command(settings.codex_path)
        checks.append("Codex CLI: 已找到（登入狀態請在本機執行 codex login status）")
    except RuntimeError:
        checks.append("Codex CLI: 未找到")
    for name in SECRET_NAMES:
        try:
            exists = bool(credential(name, required=False))
        except Exception:
            exists = False
        checks.append(f"{name}: {'已設定' if exists else '尚未設定'}")
    seed(store)
    calendar = TradingCalendar(store)
    checks += [f"交易模式: {settings.mode}", f"本日行事曆: {'已載入' if store.session(now_tw().date()) else '未知'}",
               f"今日開市: {calendar.is_open(now_tw().date())}",
               f"實際費用已核對: {settings.fee_verified}",
               f"交割正負號: {settings.settlement_debit_sign}",
               f"LIVE_TRADING: {os.environ.get('LIVE_TRADING', '').lower() == 'true'}",
               "診斷沒有連接券商、沒有下單，也沒有顯示金鑰。"]
    print("\n".join(checks))


def run_demo():
    with TemporaryDirectory(prefix="shioaji-demo-") as directory:
        store = Store(Path(directory)/"demo.db")
        settings = Settings(mode="demo", auto_execute=True, minimum_fee=1)
        engine = make_engine(store, settings)
        now = datetime(2026, 10, 8, 10, 0, tzinfo=TAIPEI)
        engine.start(now)
        snapshot = engine.snapshot(now)
        plan = demo_plan(snapshot, settings, now)
        engine.activate(plan.analysis, snapshot, now)
        for i in range(5):
            engine.tick(now+timedelta(seconds=i))
        print(engine.status(now+timedelta(seconds=5)))
        print("\n本次展示：虛構行情、模擬資金、零股買進；今日新增股數可賣量為 0。")
        engine.close()
        store.close()


def readonly_test(store):
    from .brokers.shioaji import ShioajiBroker
    settings = store.settings().model_copy(update={"mode": "readonly", "auto_execute": False})
    broker = ShioajiBroker(store, settings)
    try:
        broker.connect()
        snapshot = broker.account(now_tw())
        print(f"現金 {snapshot.cash:,.0f}；待付交割 {snapshot.settlement_debits:,.0f}；淨資產 {snapshot.equity:,.0f}")
        for position in snapshot.positions:
            print(f"{position.symbol}: {position.shares} 股，可賣 {position.sellable} 股")
        print(f"掛單 {sum(o.active for o in snapshot.orders)} 筆；完整={snapshot.complete}")
        if not snapshot.complete:
            print(snapshot.issue)
            return 1
        store.set("readonly_verified", {"at": now_tw().isoformat(), "complete": True})
        print("唯讀帳戶核對完成；沒有送單、撤單或啟用實盤。")
        return 0
    finally:
        broker.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Shioaji Codex Trader")
    parser.add_argument("--db", type=Path, default=data_directory()/"state.db")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ["doctor", "credentials", "demo", "readonly-test", "settings", "disable-live"]:
        sub.add_parser(name)
    configure = sub.add_parser("set")
    configure.add_argument("key")
    configure.add_argument("value", help="JSON 值；字串也可直接輸入")
    calendar = sub.add_parser("calendar")
    calendar.add_argument("--year", type=int, default=now_tw().year)
    calendar.add_argument("--import-csv", type=Path)
    enable = sub.add_parser("enable-live")
    enable.add_argument("--ack", required=True)
    desktop = sub.add_parser("desktop")
    desktop.add_argument("--minimized", action="store_true")
    run = sub.add_parser("run")
    run.add_argument("--seconds", type=int, default=0)
    run.add_argument("--decide-now", action="store_true")
    args = parser.parse_args(argv)
    if args.command == "demo":
        run_demo()
        return 0
    if args.command == "credentials":
        configure_credentials()
        return 0
    if args.command == "desktop":
        from .gui import main as desktop_main
        return desktop_main(["--db", str(args.db)] + (["--minimized"] if args.minimized else []))
    store = Store(args.db)
    try:
        settings = store.settings()
        if args.command == "doctor":
            doctor(store)
        elif args.command == "settings":
            print(json.dumps(settings.model_dump(mode="json"), ensure_ascii=False, indent=2))
        elif args.command == "set":
            if args.key not in Settings.model_fields:
                raise ValueError("未知設定欄位")
            try:
                value = json.loads(args.value)
            except json.JSONDecodeError:
                value = args.value
            if args.key == "mode" and value == "live":
                raise ValueError("實盤模式請使用 enable-live")
            updated = settings.model_dump()
            updated[args.key] = value
            new = Settings.model_validate(updated)
            if new.mode != settings.mode:
                if store.orders(active_only=True):
                    raise ValueError("仍有未完成本機委託；請先在原模式完成核對")
                store.set("active_plan", None)
                for protection in store.protections():
                    store.remove_protection(protection.symbol)
            store.save_settings(new)
            print("設定已保存；正在執行的程式需重新啟動。")
        elif args.command == "calendar":
            calendar = TradingCalendar(store)
            if args.import_csv:
                calendar.import_csv(args.import_csv)
            else:
                calendar.refresh_twse(args.year)
            print("交易行事曆已更新。")
        elif args.command == "readonly-test":
            return readonly_test(store)
        elif args.command == "enable-live":
            if args.ack != LIVE_ACK:
                raise ValueError("啟用確認文字不符")
            if not store.get("readonly_verified"):
                raise ValueError("請先執行 readonly-test")
            if not settings.fee_verified or settings.settlement_debit_sign == "unverified":
                raise ValueError("請先確認手續費與交割款正負號")
            if store.orders(active_only=True):
                raise ValueError("有未完成本機委託，不能切換模式")
            for name in SECRET_NAMES:
                credential(name)
            store.set("live_consent", {"at": now_tw().isoformat(), "scope": "cash-stock-auto"})
            store.set("active_plan", None)
            for protection in store.protections():
                store.remove_protection(protection.symbol)
            settings.mode = "live"
            settings.auto_execute = True
            store.save_settings(settings)
            print("本機實盤設定已保存。啟動時仍須 LIVE_TRADING=true；本指令沒有下單。")
        elif args.command == "disable-live":
            settings.mode = "readonly"
            settings.auto_execute = False
            store.save_settings(settings)
            store.set("live_consent", None)
            print("已停用實盤設定；請重新啟動。現有掛單須另行核對／撤單。")
        elif args.command == "run":
            service = Service(store)
            service.start()
            service.started.wait(30)
            if service.start_error:
                print(service.start_error)
                return 1
            if args.decide_now:
                service.post("decision", False)
            started = time.monotonic()
            try:
                while not args.seconds or time.monotonic()-started < args.seconds:
                    print(service.status(), flush=True)
                    time.sleep(5)
            except KeyboardInterrupt:
                pass
            finally:
                service.stop()
    except Exception as exc:
        print(f"未完成：{type(exc).__name__}。請檢查設定、doctor 與 README；沒有顯示敏感資料。")
        return 1
    finally:
        store.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
