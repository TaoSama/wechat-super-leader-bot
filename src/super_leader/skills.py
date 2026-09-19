from __future__ import annotations

from pathlib import Path
import os


class SkillRouter:
    def __init__(self, roots: list[str | Path] | None = None, allowlist: set[str] | None = None) -> None:
        if roots is None:
            configured = [item for item in os.environ.get("SKILL_ROOTS", "").split(os.pathsep) if item]
            roots = configured or [
                Path.home() / ".claude" / "skills",
                Path.home() / ".codex" / "skills",
                Path.home() / "Workspaces" / "dotfiles" / "claude" / "skills",
                Path.cwd() / ".claude" / "skills",
            ]
        self.roots = [Path(r).expanduser() for r in roots]
        self.allowlist = allowlist
        self.builtins = {"session-management", "node-communication", "leader-coordination", "progress-tracking", "memory-management"}

    def list_skills(self) -> list[str]:
        names: set[str] = set()
        for root in self.roots:
            if not root.is_dir():
                continue
            for skill_file in root.glob("*/SKILL.md"):
                name = skill_file.parent.name
                if self.allowlist is None or name in self.allowlist:
                    names.add(name)
        names.update(self.builtins)
        return sorted(name for name in names if self.allowlist is None or name in self.allowlist)

    def resolve(self, name: str) -> Path | None:
        if self.allowlist is not None and name not in self.allowlist:
            return None
        for root in self.roots:
            candidate = root / name / "SKILL.md"
            if candidate.is_file():
                return candidate
        return None

    def is_builtin(self, name: str) -> bool:
        return name in self.builtins

    def build_prompt(self, name: str, task: str) -> str:
        if not task.strip():
            raise ValueError("task cannot be empty")
        path = self.resolve(name)
        if path:
            instructions = path.read_text(encoding="utf-8", errors="replace")[:12000]
        elif self.is_builtin(name):
            instructions = f"这是 Super Leader 内置技能：{name}。请先确认权限、目标和完成证据，再执行任务。"
        else:
            raise ValueError(f"unknown skill: {name}")
        return f"请使用技能 {name} 完成以下任务。技能说明：\n{instructions}\n\n任务：\n{task}"
