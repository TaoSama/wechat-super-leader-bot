from __future__ import annotations

import sqlite3
from pathlib import Path


class MemoryStore:
    def __init__(self, path: str | Path = ":memory:") -> None:
        self.conn = sqlite3.connect(str(path), check_same_thread=False)
        self.conn.execute("CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
        self.conn.commit()

    def remember(self, chat_id: str, kind: str, content: str) -> None:
        if not content.strip():
            raise ValueError("memory content cannot be empty")
        self.conn.execute("INSERT INTO memories(chat_id, kind, content) VALUES (?, ?, ?)", (chat_id, kind, content.strip()))
        self.conn.commit()

    def search(self, chat_id: str, query: str, limit: int = 10) -> list[str]:
        if limit < 1:
            return []
        pattern = f"%{query.strip()}%"
        rows = self.conn.execute("SELECT content FROM memories WHERE chat_id = ? AND content LIKE ? ORDER BY id DESC LIMIT ?", (chat_id, pattern, limit)).fetchall()
        return [row[0] for row in rows]

    def close(self) -> None:
        self.conn.close()
