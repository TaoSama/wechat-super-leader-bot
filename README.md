# wechat-super-leader-bot

微信 Super Leader Agent：通过微信接收指令，统一管理多台机器上的 Codex 会话、Leader Agent、技能和记忆。

## Docs Structure

```text
docs/
├── index.md
├── changes/
├── cookbook/index.md
├── pitfall/index.md
└── runbook/index.md
```

## Quick start

```bash
cp .env.example .env
python3 -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
python -m super_leader --help
python -m super_leader --demo
```

详细配置、扫码登录和多机 Agent 注册见 `docs/runbook/index.md`。

## Workflow Skills

- `/go` — 从需求到可验证变更。
- `/ship` — 从完成的变更到可合并 PR。

