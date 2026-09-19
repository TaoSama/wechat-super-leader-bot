"""Codex app-server stdio client，用于连接桌面 Task 而不是只读 rollout 文件。"""

from __future__ import annotations

import json
import os
import selectors
import subprocess
import time
from pathlib import Path
from typing import Any


class CodexAppServerError(RuntimeError):
    pass


class CodexAppServerClient:
    def __init__(self, cwd: str | Path | None = None, command: list[str] | None = None) -> None:
        self.cwd = str(cwd or Path.cwd())
        self.command = command or ["codex", "app-server", "--stdio"]
        self.process: subprocess.Popen[str] | None = None
        self._request_id = 0
        self._selector: selectors.BaseSelector | None = None

    def start(self) -> None:
        if self.process and self.process.poll() is None:
            return
        self.process = subprocess.Popen(self.command, cwd=self.cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        self._selector = selectors.DefaultSelector()
        assert self.process.stdout is not None
        self._selector.register(self.process.stdout, selectors.EVENT_READ)
        self.request("initialize", {"clientInfo": {"name": "wechat-super-leader-bot", "version": "0.1.0"}})
        self._send({"jsonrpc": "2.0", "method": "initialized", "params": {}})

    def _send(self, message: dict[str, Any]) -> None:
        if not self.process or not self.process.stdin:
            raise CodexAppServerError("Codex app-server is not running")
        self.process.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        self.process.stdin.flush()

    def _read(self, timeout: float) -> dict[str, Any]:
        if not self._selector:
            raise CodexAppServerError("Codex app-server is not running")
        events = self._selector.select(timeout)
        if not events:
            raise TimeoutError("Timed out waiting for Codex app-server")
        line = events[0][0].fileobj.readline()
        if not line:
            raise CodexAppServerError("Codex app-server closed its stdio stream")
        value = json.loads(line)
        return value if isinstance(value, dict) else {}

    def request(self, method: str, params: dict[str, Any], timeout: float = 30.0) -> dict[str, Any]:
        self.start_without_initialize() if method == "initialize" and not self.process else None
        self._request_id += 1
        request_id = self._request_id
        self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = self._read(max(0.01, deadline - time.monotonic()))
            if value.get("id") != request_id:
                self._handle_server_request(value)
                continue
            if "error" in value:
                raise CodexAppServerError(str(value["error"]))
            result = value.get("result", {})
            return result if isinstance(result, dict) else {"value": result}
        raise TimeoutError(f"Timed out waiting for Codex method {method}")

    def start_without_initialize(self) -> None:
        self.process = subprocess.Popen(self.command, cwd=self.cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        self._selector = selectors.DefaultSelector()
        assert self.process.stdout is not None
        self._selector.register(self.process.stdout, selectors.EVENT_READ)

    def _handle_server_request(self, value: dict[str, Any]) -> None:
        if "id" in value and value.get("method", "").endswith("requestApproval"):
            self._send({"jsonrpc": "2.0", "id": value["id"], "result": {"decision": "decline"}})

    def list_threads(self, cwd: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        self.start()
        result = self.request("thread/list", {"cwd": cwd, "limit": limit, "useStateDbOnly": True})
        data = result.get("data", [])
        return data if isinstance(data, list) else []

    def read_thread(self, thread_id: str, include_turns: bool = True) -> dict[str, Any]:
        self.start()
        return self.request("thread/read", {"threadId": thread_id, "includeTurns": include_turns})

    def send_turn(self, thread_id: str, text: str, model: str | None = None, timeout: float = 300.0) -> str:
        self.start()
        params: dict[str, Any] = {"threadId": thread_id, "input": [{"type": "text", "text": text}], "approvalPolicy": "never"}
        if model:
            params["model"] = model
        result = self.request("turn/start", params)
        turn = result.get("turn", {})
        turn_id = turn.get("id") if isinstance(turn, dict) else None
        if not turn_id:
            return json.dumps(result, ensure_ascii=False)
        deadline = time.monotonic() + timeout
        chunks: list[str] = []
        while time.monotonic() < deadline:
            value = self._read(max(0.01, deadline - time.monotonic()))
            if value.get("method", "").endswith("requestApproval"):
                self._handle_server_request(value)
                continue
            params_value = value.get("params", {})
            if not isinstance(params_value, dict) or params_value.get("turnId") != turn_id:
                continue
            if value.get("method") == "item/agentMessage/delta":
                delta = params_value.get("delta")
                if isinstance(delta, str):
                    chunks.append(delta)
            if value.get("method") == "turn/completed":
                break
        return "".join(chunks).strip()

    def close(self) -> None:
        if self._selector:
            self._selector.close()
            self._selector = None
        if self.process and self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=5)
        self.process = None
