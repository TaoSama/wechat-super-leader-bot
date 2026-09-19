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
        self.conn = sqlite3.connect(str(path))
        self.conn.execute("CREATE TABLE IF NOT EXISTS nodes (name TEXT PRIMARY KEY, address TEXT NOT NULL, token_hash TEXT NOT NULL, status TEXT NOT NULL, last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
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
        row = self.conn.execute("SELECT token_hash FROM nodes WHERE name = ?", (name,)).fetchone()
        if not row or not secrets.compare_digest(row[0], self._hash(token)):
            return False
        self.conn.execute("UPDATE nodes SET status='online', last_seen=CURRENT_TIMESTAMP WHERE name=?", (name,))
        self.conn.commit()
        return True

    def list_nodes(self) -> list[Node]:
        rows = self.conn.execute("SELECT name,address,status,last_seen FROM nodes ORDER BY name").fetchall()
        return [Node(*row) for row in rows]

    def close(self) -> None:
        self.conn.close()

