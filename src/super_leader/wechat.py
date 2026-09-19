from __future__ import annotations

import re
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
