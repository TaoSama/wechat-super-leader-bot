# app-server 只读实机证据

2026-09-19 本轮使用当前本机 Codex CLI 启动 `codex app-server --stdio`，通过项目客户端完成只读调用：

- `thread/list(limit=3)` 返回 3 个桌面 Task。
- `thread/read(includeTurns=false)` 对首个 Task 返回字典结果。
- `tests/test_codex_app_server.py` 实测 4 passed。

本轮没有调用 `turn/start`，没有启动模型任务、修改 Task、发送微信消息或修改系统配置；因此只证明列表/读取通道可用，不证明写入 turn、完成通知或审批链路已经实机通过。
