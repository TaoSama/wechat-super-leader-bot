from __future__ import annotations

import re
import base64
import json
import os
import secrets
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from enum import Enum
from typing import Iterator


@dataclass(frozen=True)
class WeChatMessage:
    chat_id: str
    text: str
    message_id: str


def markdown_for_wechat(text: str, max_chars: int = 4000) -> str:
    text = re.sub(r"```(?:\w+)?\n?(.*?)```", r"\1", text, flags=re.S)
    text = re.sub(r"!\[([^]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\[([^]]+)\]\(([^)]+)\)", r"\1: \2", text)
    text = re.sub(r"[*_~`]", "", text)
    return text.strip()[:max_chars]


def markdown_to_wechat(text: str, max_chars: int = 4000) -> str:
    text = re.sub(r"^#{1,6}\s*", "", text, flags=re.M)
    text = re.sub(r"^\s*-\s+", "• ", text, flags=re.M)
    text = re.sub(r"\[([^]]+)\]\(([^)]+)\)", r"\1 (\2)", text)
    return markdown_for_wechat(text, max_chars)


class ScanStatus(Enum):
    IDLE = "idle"
    WAITING = "waiting"
    SCANNED = "scanned"
    CONFIRMED = "confirmed"


@dataclass(frozen=True)
class ScanResult:
    status: ScanStatus
    qr_url: str = "mock://wechat/qr"


class MockWeChatTransport:
    def __init__(self, qr_path: str | None = None) -> None:
        self.inbox: list[WeChatMessage] = []
        self.outbox: list[tuple[str, str]] = []
        self.qr_ready = False
        self.scan_status = ScanStatus.IDLE
        self.sent_messages: tuple[object, ...] = ()
        self.closed = False

    def start_login(self) -> ScanResult:
        self.qr_ready = True
        self.scan_status = ScanStatus.WAITING
        return ScanResult(self.scan_status)

    def mark_scanned(self) -> ScanResult:
        self.scan_status = ScanStatus.SCANNED
        return ScanResult(self.scan_status)

    def confirm_login(self) -> ScanResult:
        self.scan_status = ScanStatus.CONFIRMED
        return ScanResult(self.scan_status)

    def inject_message(self, chat_id: str, text: str, sender_id: str = "") -> WeChatMessage:
        message = WeChatMessage(chat_id, text, f"mock-{len(self.inbox)+1}")
        self.inbox.append(message)
        return message

    def receive(self, timeout: float = 0.0) -> WeChatMessage | None:
        return self.inbox.pop(0) if self.inbox and not self.closed else None

    def poll(self) -> Iterator[WeChatMessage]:
        while self.inbox:
            yield self.inbox.pop(0)

    def send(self, chat_id: str, text: str) -> None:
        if self.closed:
            raise RuntimeError("transport is closed")
        item = (chat_id, markdown_to_wechat(text))
        self.outbox.append(item)
        self.sent_messages = (item,)
        return item

    def close(self) -> None:
        self.closed = True


MockWechatTransport = MockWeChatTransport


class WechatAdapter:
    def __init__(self, transport: MockWeChatTransport) -> None:
        self.transport = transport

    def send(self, chat_id: str, text: str) -> WeChatMessage | object:
        result = self.transport.send(chat_id, text)
        return type("SentMessage", (), {"chat_id": chat_id, "text": markdown_to_wechat(text), "raw": result})()


class ILinkWeChatTransport:
    """微信 iLink Bot transport。

    iLink 使用二维码登录、`getupdates` 长轮询和 `sendmessage` 回复。
    凭据默认写入用户目录，不进入仓库；首次登录请在终端运行 :meth:`login`。
    """

    def __init__(self, credentials_path: str | None = None, base_url: str | None = None, timeout: float = 35.0) -> None:
        self.credentials_path = credentials_path or os.environ.get("WECHAT_CREDENTIALS_PATH") or os.path.expanduser("~/.super-leader/wechat-account.json")
        self.state_path = f"{self.credentials_path}.state.json"
        self.base_url = (base_url or os.environ.get("WECHAT_ILINK_BASE_URL") or "https://ilinkai.weixin.qq.com").rstrip("/")
        self.timeout = timeout
        self.sync_buf = ""
        self.context_tokens: dict[str, str] = {}
        self._load_state()
        self.account: dict[str, str] | None = self._load()

    def _load(self) -> dict[str, str] | None:
        try:
            with open(self.credentials_path, encoding="utf-8") as handle:
                value = json.load(handle)
            return value if isinstance(value, dict) and value.get("token") else None
        except (OSError, json.JSONDecodeError):
            return None

    def _load_state(self) -> None:
        try:
            with open(self.state_path, encoding="utf-8") as handle:
                state = json.load(handle)
            if isinstance(state, dict):
                self.sync_buf = str(state.get("sync_buf") or "")
                tokens = state.get("context_tokens")
                if isinstance(tokens, dict):
                    self.context_tokens = {str(k): str(v) for k, v in tokens.items() if v}
        except (OSError, json.JSONDecodeError):
            return

    def _save_state(self) -> None:
        path = os.path.abspath(os.path.expanduser(self.state_path))
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"sync_buf": self.sync_buf, "context_tokens": self.context_tokens}, handle, ensure_ascii=False, indent=2)
        os.chmod(path, 0o600)

    def _request(self, endpoint: str, payload: dict[str, object], token: str | None = None, timeout: float | None = None) -> dict[str, object]:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "AuthorizationType": "ilink_bot_token",
            "X-WECHAT-UIN": base64.b64encode(str(secrets.randbits(32)).encode()).decode(),
        }
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = urllib.request.Request(f"{self.base_url}/{endpoint.lstrip('/')}", data=body, headers=headers, method="POST")
        with urllib.request.urlopen(request, timeout=timeout or self.timeout) as response:
            result = json.loads(response.read().decode("utf-8"))
        if not isinstance(result, dict):
            raise RuntimeError("WeChat iLink returned a non-object response")
        return result

    def _get(self, endpoint: str, timeout: float | None = None) -> dict[str, object]:
        request = urllib.request.Request(f"{self.base_url}/{endpoint.lstrip('/')}", headers={"iLink-App-ClientVersion": "1"}, method="GET")
        with urllib.request.urlopen(request, timeout=timeout or self.timeout) as response:
            result = json.loads(response.read().decode("utf-8"))
        if not isinstance(result, dict):
            raise RuntimeError("WeChat iLink returned a non-object response")
        return result

    def login(self, poll_interval: float = 1.0, timeout: float = 480.0) -> dict[str, str]:
        """获取二维码并等待扫码确认，返回并保存账号凭据。"""
        query = urllib.parse.urlencode({"bot_type": "3"})
        qr = self._get(f"ilink/bot/get_bot_qrcode?{query}", timeout=15)
        code = str(qr.get("qrcode", ""))
        login_url = str(qr.get("qrcode_img_content", ""))
        if not code or not login_url:
            raise RuntimeError(f"WeChat QR response missing qrcode fields: {qr}")
        print(f"请用微信扫码（短时有效）：{login_url}")
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            query = urllib.parse.urlencode({"qrcode": code})
            status = self._get(f"ilink/bot/get_qrcode_status?{query}", timeout=40)
            state = status.get("status")
            if state == "scaned":
                print("已扫码，请在手机上确认登录。")
            elif state == "expired":
                raise RuntimeError("WeChat QR code expired; run login again")
            elif state == "confirmed":
                token = status.get("bot_token")
                account_id = status.get("ilink_bot_id")
                if not isinstance(token, str) or not isinstance(account_id, str):
                    raise RuntimeError("WeChat login confirmed without bot credentials")
                self.account = {"token": token, "accountId": account_id, "baseUrl": str(status.get("baseurl") or self.base_url), "userId": str(status.get("ilink_user_id") or ""), "savedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
                path = os.path.abspath(os.path.expanduser(self.credentials_path))
                os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
                with open(path, "w", encoding="utf-8") as handle:
                    json.dump(self.account, handle, ensure_ascii=False, indent=2)
                os.chmod(path, 0o600)
                self.sync_buf = ""
                self.context_tokens = {}
                self._save_state()
                return self.account
            time.sleep(poll_interval)
        raise TimeoutError("WeChat QR login timed out")

    def poll(self, timeout: float | None = None) -> Iterator[WeChatMessage]:
        if not self.account:
            raise RuntimeError("WeChat is not logged in; run ILinkWeChatTransport.login()")
        response = self._request("ilink/bot/getupdates", {"get_updates_buf": self.sync_buf, "base_info": {"channel_version": "0.3.0"}}, self.account["token"], timeout or self.timeout)
        self.sync_buf = str(response.get("get_updates_buf") or self.sync_buf)
        self._save_state()
        for message in response.get("msgs") or []:
            if not isinstance(message, dict) or message.get("message_type") != 1:
                continue
            sender = str(message.get("from_user_id") or "unknown")
            text = "".join(str(item.get("text_item", {}).get("text", "")) for item in message.get("item_list", []) if isinstance(item, dict) and item.get("type") == 1)
            if not text:
                continue
            token = message.get("context_token")
            if token:
                self.context_tokens[sender] = str(token)
            self._save_state()
            yield WeChatMessage(sender, text, str(message.get("client_id") or message.get("create_time_ms") or ""))

    def send(self, chat_id: str, text: str) -> None:
        if not self.account:
            raise RuntimeError("WeChat is not logged in")
        context = self.context_tokens.get(chat_id, "")
        if not context:
            raise RuntimeError("No context token for this chat; poll a new inbound message first")
        self._request("ilink/bot/sendmessage", {"msg": {"from_user_id": "", "to_user_id": chat_id, "client_id": f"super-leader:{time.time_ns()}", "message_type": 2, "message_state": 2, "item_list": [{"type": 1, "text_item": {"text": markdown_to_wechat(text)}}], "context_token": context}, "base_info": {"channel_version": "0.3.0"}}, self.account["token"], timeout=15)
