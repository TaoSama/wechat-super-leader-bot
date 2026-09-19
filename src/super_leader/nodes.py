from __future__ import annotations

import hashlib
import secrets
import sqlite3
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Node:
    name: str
    address: str
    status: str
    last_seen: str


class NodeRegistry:
    def __init__(self, path: str | Path = ":memory:") -> None:
        self.conn = sqlite3.connect(str(path), check_same_thread=False)
        self.conn.execute("CREATE TABLE IF NOT EXISTS nodes (name TEXT PRIMARY KEY, address TEXT NOT NULL, token_hash TEXT NOT NULL, status TEXT NOT NULL, last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
        self.conn.execute("CREATE TABLE IF NOT EXISTS tasks (task_id TEXT PRIMARY KEY, node_name TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
        self.conn.commit()

    @staticmethod
    def _hash(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    def register(self, name: str, address: str) -> str:
        token = secrets.token_urlsafe(24)
        self.conn.execute("INSERT OR REPLACE INTO nodes(name,address,token_hash,status) VALUES(?,?,?,'online')", (name, address, self._hash(token)))
        self.conn.commit()
        return token

    def heartbeat(self, name: str, token: str) -> bool:
        if not self.authenticate(name, token):
            return False
        self.conn.execute("UPDATE nodes SET status='online', last_seen=CURRENT_TIMESTAMP WHERE name=?", (name,))
        self.conn.commit()
        return True

    def authenticate(self, name: str, token: str) -> bool:
        row = self.conn.execute("SELECT token_hash FROM nodes WHERE name = ?", (name,)).fetchone()
        return bool(row and secrets.compare_digest(row[0], self._hash(token)))

    def list_nodes(self) -> list[Node]:
        rows = self.conn.execute("SELECT name,address,status,last_seen FROM nodes ORDER BY name").fetchall()
        return [Node(*row) for row in rows]

    def dispatch(self, node_name: str, task_id: str, payload: str) -> bool:
        if not node_name.strip() or not task_id.strip() or not payload.strip():
            raise ValueError("node_name, task_id and payload are required")
        node = self.conn.execute("SELECT status FROM nodes WHERE name = ?", (node_name,)).fetchone()
        if not node or node[0] != "online":
            return False
        self.conn.execute("INSERT OR REPLACE INTO tasks(task_id,node_name,payload,status) VALUES(?,?,?,'queued')", (task_id, node_name, payload))
        self.conn.commit()
        return True

    def update_task(self, task_id: str, status: str) -> bool:
        allowed = {"queued", "running", "completed", "failed", "cancelled"}
        if status not in allowed:
            raise ValueError(f"unsupported task status: {status}")
        cursor = self.conn.execute("UPDATE tasks SET status=?, updated_at=CURRENT_TIMESTAMP WHERE task_id=?", (status, task_id))
        self.conn.commit()
        return cursor.rowcount == 1

    def list_tasks(self) -> list[dict[str, str]]:
        rows = self.conn.execute("SELECT task_id,node_name,payload,status,created_at,updated_at FROM tasks ORDER BY created_at DESC").fetchall()
        return [{"task_id": r[0], "node_name": r[1], "payload": r[2], "status": r[3], "created_at": r[4], "updated_at": r[5]} for r in rows]

    def claim_tasks(self, node_name: str, token: str, limit: int = 10) -> list[dict[str, str]]:
        if not self.authenticate(node_name, token):
            return []
        rows = self.conn.execute("SELECT task_id,payload FROM tasks WHERE node_name=? AND status='queued' ORDER BY created_at LIMIT ?", (node_name, limit)).fetchall()
        for task_id, _ in rows:
            self.conn.execute("UPDATE tasks SET status='running', updated_at=CURRENT_TIMESTAMP WHERE task_id=?", (task_id,))
        self.conn.commit()
        return [{"task_id": task_id, "payload": payload, "status": "running"} for task_id, payload in rows]

    def close(self) -> None:
        self.conn.close()
