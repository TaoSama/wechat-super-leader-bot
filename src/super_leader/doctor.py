from __future__ import annotations

import os
import shutil
import urllib.request
from pathlib import Path

from .codex_app_server import CodexAppServerClient


def run_check(data_dir: str | Path = "data") -> list[tuple[str, bool, str]]:
    checks: list[tuple[str, bool, str]] = []
    codex_path = shutil.which("codex")
    checks.append(("codex CLI", codex_path is not None, codex_path or "未找到 codex"))
    try:
        client = CodexAppServerClient()
        threads = client.list_threads(limit=1)
        client.close()
        checks.append(("Codex app-server", True, f"可读取，当前返回 {len(threads)} 条 Task"))
    except Exception as error:
        checks.append(("Codex app-server", False, str(error)))
    base_url = (os.environ.get("WECHAT_ILINK_BASE_URL") or "https://ilinkai.weixin.qq.com").rstrip("/")
    try:
        request = urllib.request.Request(f"{base_url}/ilink/bot/get_bot_qrcode?bot_type=3", method="GET")
        with urllib.request.urlopen(request, timeout=10) as response:
            ok = response.status == 200
            checks.append(("微信 iLink QR 接口", ok, f"HTTP {response.status}"))
    except Exception as error:
        checks.append(("微信 iLink QR 接口", False, str(error)))
    path = Path(data_dir)
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / ".write-check"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        checks.append(("数据目录", True, str(path.resolve())))
    except OSError as error:
        checks.append(("数据目录", False, str(error)))
    credentials = Path(os.path.expanduser(os.environ.get("WECHAT_CREDENTIALS_PATH", "~/.super-leader/wechat-account.json")))
    checks.append(("微信凭据", credentials.is_file(), str(credentials)))
    return checks

