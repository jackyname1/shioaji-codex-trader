from __future__ import annotations

import os
from getpass import getpass
from pathlib import Path

SERVICE = "ShioajiCodexTrader"
SECRET_NAMES = ("SJ_API_KEY", "SJ_SEC_KEY", "SJ_CA_PATH", "SJ_CA_PASSWD")


def credential(name: str, required=True) -> str:
    value = os.environ.get(name, "")
    if not value:
        try:
            import keyring
            value = keyring.get_password(SERVICE, name) or ""
        except Exception:
            value = ""
    if required and not value:
        raise RuntimeError(f"尚未在本機設定 {name}")
    return value


def configure_credentials():
    import keyring
    backend = keyring.get_keyring()
    if backend.priority <= 0 or "plaintext" in type(backend).__name__.lower():
        raise RuntimeError("沒有可用的作業系統安全憑證儲存服務")
    labels = {"SJ_API_KEY": "Shioaji API Key", "SJ_SEC_KEY": "Shioaji Secret Key",
              "SJ_CA_PATH": "CA .pfx 路徑（可留空，僅查詢不需要）",
              "SJ_CA_PASSWD": "CA 密碼（可留空）"}
    values = {}
    for name in SECRET_NAMES:
        value = getpass(labels[name]+": ").strip()
        if value:
            if name == "SJ_CA_PATH" and not Path(value).is_file():
                raise RuntimeError("憑證路徑不存在；沒有儲存任何新設定")
            values[name] = value
    for name, value in values.items():
        keyring.set_password(SERVICE, name, value)
    print("已儲存到本機憑證管理員；沒有將金鑰寫入專案。")
