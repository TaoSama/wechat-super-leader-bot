"""把微信消息路由到本机 Codex、远程节点、技能和记忆。"""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
from typing import Any


@dataclass
class CommandResult:
    text: str
    data: dict[str, Any] | None = None


class SuperLeader:
    """无状态编排入口；外部 transport 负责收发消息。"""

    def __init__(self, data_dir: str | Path = "data", allowed_chat_ids: set[str] | None = None) -> None:
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        from .codex_sessions import CodexSessionManager
        from .codex_app_server import CodexAppServerClient
        from .memory import MemoryStore
        from .nodes import NodeRegistry
        from .skills import SkillRouter

        self.sessions = CodexSessionManager()
        self.desktop = CodexAppServerClient()
        self.nodes = NodeRegistry(self.data_dir / "nodes.sqlite3")
        self.memory = MemoryStore(self.data_dir / "memory.sqlite3")
        self.skills = SkillRouter()
        configured_ids = os.environ.get("ALLOWED_CHAT_IDS", "")
        self.allowed_chat_ids = allowed_chat_ids if allowed_chat_ids is not None else {item.strip() for item in configured_ids.split(",") if item.strip()}

    def handle(self, message: str, chat_id: str = "local") -> CommandResult:
        """处理一条普通文本命令，保持输出适合微信展示。"""
        text = message.strip()
        if not text:
            return CommandResult("请发送任务或输入 /help 查看命令。")
        if self.allowed_chat_ids and chat_id not in self.allowed_chat_ids:
            return CommandResult("当前微信账号未被授权使用此机器人。")
        if not text.startswith("/remember "):
            self.memory.remember(chat_id, "user", text)
        if text in {"/help", "帮助", "菜单"}:
            return CommandResult(
                "可用命令：\n"
                "/sessions 查看 Codex 会话\n"
                "/threads 查看 Codex 桌面 Task\n"
                "/turn <thread_id> <任务> 发送到桌面 Task\n"
                "/nodes 查看已注册机器\n"
                "/skills 查看技能\n"
                "/remember <内容> 保存记忆\n"
                "/codex <session_id> <任务> 发送到现有会话\n"
                "/fork [model] <任务> 创建独立 Codex 会话\n"
                "直接发送任务可交给 Super Leader 分派。"
            )
        if text == "/sessions":
            rows = self.sessions.list_sessions()
            if not rows:
                return CommandResult("暂未发现本机 Codex 会话。")
            return CommandResult("本机 Codex 会话：\n" + "\n".join(self.sessions.format_session(r) for r in rows))
        if text == "/threads":
            try:
                rows = self.desktop.list_threads(limit=20)
            except Exception as error:
                return CommandResult(f"读取 Codex 桌面 Task 失败：{error}")
            if not rows:
                return CommandResult("暂无 Codex 桌面 Task。")
            return CommandResult("Codex 桌面 Task：\n" + "\n".join(f"- {row.get('id', '?')}：{row.get('name') or row.get('preview') or ''}" for row in rows))
        if text == "/nodes":
            rows = self.nodes.list_nodes()
            return CommandResult("已注册节点：\n" + "\n".join(f"- {n.name} ({n.status})" for n in rows) if rows else "暂无已注册节点。")
        if text == "/skills":
            names = self.skills.list_skills()
            return CommandResult("可用技能：\n" + "\n".join(f"- {name}" for name in names) if names else "暂无可发现技能。")
        if text.startswith("/remember "):
            value = text.removeprefix("/remember ").strip()
            if not value:
                return CommandResult("记忆内容不能为空。")
            self.memory.remember(chat_id, "memory", value)
            return CommandResult("已保存到长期记忆。")
        if text.startswith("/codex "):
            _, session_id, prompt = text.split(" ", 2) if len(text.split(" ", 2)) == 3 else ("", "", "")
            if not session_id or not prompt.strip():
                return CommandResult("用法：/codex <session_id> <任务>")
            result = self.sessions.send(session_id, prompt)
            output = (result.stdout or result.stderr or "Codex 已接受任务").strip()
            return CommandResult(output[-3500:])
        if text.startswith("/turn "):
            parts = text.split(" ", 2)
            if len(parts) != 3:
                return CommandResult("用法：/turn <thread_id> <任务>")
            try:
                output = self.desktop.send_turn(parts[1], parts[2])
            except Exception as error:
                return CommandResult(f"发送到 Codex 桌面 Task 失败：{error}")
            return CommandResult(output or "Codex 已接受任务。")
        if text.startswith("/fork "):
            parts = text.split(" ", 2)
            if len(parts) == 2:
                model, prompt = None, parts[1]
            elif parts[1].startswith("gpt-") or parts[1].startswith("claude-"):
                model, prompt = parts[1], parts[2]
            else:
                model, prompt = None, text.removeprefix("/fork ")
            result = self.sessions.fork(prompt, model)
            output = (result.stdout or result.stderr or "Codex 子会话已创建").strip()
            return CommandResult(output[-3500:])
        self.memory.remember(chat_id, "task", text)
        return CommandResult("已收到任务，正在由 Super Leader 分析并选择本机会话、远程节点或技能。", {"accepted": True})
