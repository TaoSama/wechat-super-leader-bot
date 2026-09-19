# wechat-super-leader-bot

微信 Super Leader Agent：通过微信接收指令，统一管理多台机器上的 Codex 会话、Leader Agent、技能和记忆。

代码仓库：[github.com/TaoSama/wechat-super-leader-bot](https://github.com/TaoSama/wechat-super-leader-bot)（Private）。

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

当前首版已经可以本地启动、发现 Codex sessions、保存记忆、注册节点，并通过 mock transport 完成消息收发和微信 Markdown 降级。真实微信扫码 transport 已预留接口，需按你实际使用的微信接入通道配置凭据后启用。

## Workflow Skills

- `/go` — 从需求到可验证变更。
- `/ship` — 从完成的变更到可合并 PR。
