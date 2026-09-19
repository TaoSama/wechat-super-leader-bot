from __future__ import annotations

from pathlib import Path


class SkillRouter:
    def __init__(self, roots: list[str | Path] | None = None, allowlist: set[str] | None = None) -> None:
        self.roots = [Path(r).expanduser() for r in (roots or [])]
        self.allowlist = allowlist

    def list_skills(self) -> list[str]:
        names: set[str] = set()
        for root in self.roots:
            if not root.is_dir():
                continue
            for skill_file in root.glob("*/SKILL.md"):
                name = skill_file.parent.name
                if self.allowlist is None or name in self.allowlist:
                    names.add(name)
        return sorted(names)

    def resolve(self, name: str) -> Path | None:
        if self.allowlist is not None and name not in self.allowlist:
            return None
        for root in self.roots:
            candidate = root / name / "SKILL.md"
            if candidate.is_file():
                return candidate
        return None

