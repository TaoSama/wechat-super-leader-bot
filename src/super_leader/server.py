"""本地/内网 HTTP 控制面：微信入口和远程节点共用。"""

from __future__ import annotations

import hmac
import json
import os
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from .app import SuperLeader


class ControlPlane:
    def __init__(self, leader: SuperLeader, auth_token: str | None = None) -> None:
        self.leader = leader
        self.auth_token = auth_token or os.environ.get("AUTH_TOKEN", "")

    def authorized(self, value: str | None) -> bool:
        return bool(self.auth_token) and hmac.compare_digest(value or "", f"Bearer {self.auth_token}")


def make_handler(control: ControlPlane):
    class Handler(BaseHTTPRequestHandler):
        def _json(self, status: int, value: object) -> None:
            body = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self) -> dict[str, object]:
            length = int(self.headers.get("Content-Length", "0"))
            value = json.loads(self.rfile.read(length) or b"{}")
            return value if isinstance(value, dict) else {}

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/health":
                self._json(HTTPStatus.OK, {"ok": True})
                return
            if self.path.startswith("/nodes/") and self.path.endswith("/tasks"):
                name = self.path.split("/")[2]
                token = self.headers.get("X-Node-Token", "")
                if not control.leader.nodes.authenticate(name, token):
                    self._json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                    return
                self._json(HTTPStatus.OK, {"tasks": control.leader.nodes.claim_tasks(name, token)})
                return
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            path = urlparse(self.path).path
            if path == "/messages":
                body = self._body()
                if not control.authorized(self.headers.get("Authorization")):
                    self._json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                    return
                chat_id = str(body.get("chat_id", "local"))
                result = control.leader.handle(str(body.get("text", "")), chat_id)
                self._json(HTTPStatus.OK, {"text": result.text, "data": result.data})
                return
            if path == "/nodes/register":
                if not control.authorized(self.headers.get("Authorization")):
                    self._json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                    return
                body = self._body()
                name, address = str(body.get("name", "")), str(body.get("address", ""))
                if not name or not address:
                    self._json(HTTPStatus.BAD_REQUEST, {"error": "name and address are required"})
                    return
                token = control.leader.nodes.register(name, address)
                self._json(HTTPStatus.OK, {"name": name, "token": token})
                return
            if path == "/nodes/heartbeat":
                body = self._body()
                name = str(body.get("name", ""))
                token = self.headers.get("X-Node-Token", "")
                self._json(HTTPStatus.OK if control.leader.nodes.heartbeat(name, token) else HTTPStatus.UNAUTHORIZED, {"ok": control.leader.nodes.authenticate(name, token)})
                return
            if path == "/nodes/dispatch":
                if not control.authorized(self.headers.get("Authorization")):
                    self._json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                    return
                body = self._body()
                accepted = control.leader.nodes.dispatch(str(body.get("node_name", "")), str(body.get("task_id", "")), str(body.get("payload", "")))
                self._json(HTTPStatus.OK if accepted else HTTPStatus.CONFLICT, {"accepted": accepted})
                return
            if path == "/nodes/task-status":
                body = self._body()
                name = str(body.get("name", ""))
                token = self.headers.get("X-Node-Token", "")
                if not control.leader.nodes.authenticate(name, token):
                    self._json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                    return
                updated = control.leader.nodes.update_task(str(body.get("task_id", "")), str(body.get("status", "")))
                self._json(HTTPStatus.OK if updated else HTTPStatus.NOT_FOUND, {"updated": updated})
                return
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})

        def log_message(self, *_args: object) -> None:
            return

    return Handler


def serve(leader: SuperLeader, host: str = "127.0.0.1", port: int = 8787, auth_token: str | None = None) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), make_handler(ControlPlane(leader, auth_token)))
    return server
