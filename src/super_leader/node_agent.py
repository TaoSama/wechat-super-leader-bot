"""远程机器上的轻量节点：注册、心跳、拉取任务并交给 Codex。"""

from __future__ import annotations

import json
import time
import urllib.request
import uuid
from typing import Callable

from .codex_sessions import CodexSessionManager


class NodeAgent:
    def __init__(self, server_url: str, name: str, address: str, auth_token: str, executor: Callable[[str], str] | None = None) -> None:
        self.server_url = server_url.rstrip("/")
        self.name = name
        self.address = address
        self.auth_token = auth_token
        self.token: str | None = None
        self.executor = executor or (lambda payload: payload)
        self.sessions = CodexSessionManager()

    def _request(self, path: str, payload: dict[str, object], headers: dict[str, str]) -> dict[str, object]:
        body = json.dumps(payload, ensure_ascii=False).encode()
        request = urllib.request.Request(self.server_url + path, data=body, headers={"Content-Type": "application/json", **headers}, method="POST")
        with urllib.request.urlopen(request, timeout=15) as response:
            value = json.loads(response.read().decode())
        return value if isinstance(value, dict) else {}

    def register(self) -> str:
        result = self._request("/nodes/register", {"name": self.name, "address": self.address}, {"Authorization": f"Bearer {self.auth_token}"})
        token = result.get("token")
        if not isinstance(token, str) or not token:
            raise RuntimeError(f"node registration failed: {result}")
        self.token = token
        return token

    def heartbeat(self) -> bool:
        if not self.token:
            raise RuntimeError("register the node before heartbeat")
        result = self._request("/nodes/heartbeat", {"name": self.name}, {"X-Node-Token": self.token})
        return result.get("ok") is True

    def report_sessions(self) -> bool:
        if not self.token:
            raise RuntimeError("register the node before reporting sessions")
        result = self._request("/nodes/sessions", {"name": self.name, "sessions": self.sessions.list_sessions()}, {"X-Node-Token": self.token})
        return result.get("ok") is True

    def dispatch_once(self) -> list[dict[str, object]]:
        if not self.token:
            raise RuntimeError("register the node before polling")
        request = urllib.request.Request(f"{self.server_url}/nodes/{self.name}/tasks", headers={"X-Node-Token": self.token}, method="GET")
        with urllib.request.urlopen(request, timeout=15) as response:
            value = json.loads(response.read().decode())
        tasks = value.get("tasks", []) if isinstance(value, dict) else []
        completed: list[dict[str, object]] = []
        for task in tasks if isinstance(tasks, list) else []:
            if not isinstance(task, dict):
                continue
            task_id = str(task.get("task_id", uuid.uuid4()))
            try:
                output = self.executor(str(task.get("payload", "")))
                status = "completed"
            except Exception as error:
                output = str(error)
                status = "failed"
            self._request("/nodes/task-status", {"name": self.name, "task_id": task_id, "status": status}, {"X-Node-Token": self.token})
            completed.append({"task_id": task_id, "output": output})
        return completed

    def run(self, interval: float = 30.0) -> None:
        if not self.token:
            self.register()
        while True:
            self.heartbeat()
            self.report_sessions()
            self.dispatch_once()
            time.sleep(interval)
