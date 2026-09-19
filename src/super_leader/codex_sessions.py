from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Callable


class CodexSessionManager:
    def __init__(self, sessions_dir: str | Path | None = None, runner: Callable[..., subprocess.CompletedProcess[str]] | None = None) -> None:
        self.sessions_dir = Path(sessions_dir or os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "sessions"
        self.runner = runner or subprocess.run

    def list_sessions(self) -> list[dict[str, str]]:
        if not self.sessions_dir.is_dir():
            return []
        result: list[dict[str, str]] = []
        for path in sorted(self.sessions_dir.rglob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)[:100]:
            result.append({"id": path.stem, "path": str(path), "updated": str(int(path.stat().st_mtime))})
        return result

    @staticmethod
    def format_session(session: dict[str, str]) -> str:
        return f"- {session['id']}（更新 {session.get('updated', '?')}）"

    def get(self, session_id: str) -> dict[str, object] | None:
        for session in self.list_sessions():
            if session["id"] == session_id:
                lines = Path(session["path"]).read_text(encoding="utf-8", errors="replace").splitlines()
                return {"session": session, "events": [json.loads(line) for line in lines[-20:] if line.strip()]}
        return None

    def send(self, session_id: str, prompt: str) -> subprocess.CompletedProcess[str]:
        if not prompt.strip():
            raise ValueError("prompt cannot be empty")
        return self.runner("codex", "exec", "--session", session_id, prompt, check=False, text=True, capture_output=True)

    def fork(self, prompt: str, model: str | None = None) -> subprocess.CompletedProcess[str]:
        args = ["codex", "exec", "--fork-turns", "none"]
        if model:
            args.extend(["--model", model])
        args.append(prompt)
        return self.runner(*args, check=False, text=True, capture_output=True)

