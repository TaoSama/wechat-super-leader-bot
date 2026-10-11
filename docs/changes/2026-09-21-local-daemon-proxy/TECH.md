# 优先连接本机 Codex daemon

Codex CLI 0.153.3 的 control socket 实际接受 WebSocket Upgrade，而不是裸 JSONL。客户端默认检查 `CODEX_APP_SERVER_SOCKET`，未配置时检查 `~/.codex/app-server-control/app-server-control.sock`；确认为 Unix socket 后采用内置 WebSocket 传输，这使 `/threads`、`/use` 和普通文本 turn 有机会操作同一 app-server daemon 的 Task，而不是另起独立状态。`codex app-server proxy --sock PATH` 在本机诊断中不产生可读 JSON，因此不再作为客户端传输实现。

socket 存在不代表 daemon 可用：本机实测 proxy 在 initialize 阶段 3 秒无响应，因此客户端捕获初始化超时/协议错误，关闭代理并回退独立 stdio。回退避免微信 BOT 完全不可用；进程重启会重新探测。未自动启动、停止或修改 Codex daemon，也未读取认证凭据。

## 验证与证据边界

新增默认命令选择与缺失 socket 回退测试；保留真实 CLI 可见线程 smoke test。`.venv/bin/python -m pytest -q tests/test_codex_app_server.py`：20 passed in 3.17s；全量 pytest：396 passed in 8.78s；compileall、git diff --check 通过。

直接命令 `codex app-server daemon version` 观测到本机 daemon 状态 running、socket 路径和版本 0.153.3；向 proxy 发送 initialize 未收到响应，因此“可连接桌面 Task”仍是待验证，不把 socket 存在误当作成功。测试中的真实命令只读初始化/列表，未发送 turn、微信消息或跨机请求。测试耗时为单次观测，无性能推算；daemon 日志显示已有模型刷新超时和线程 writer conflict，但本轮未改其状态。

回退只需恢复固定 stdio 命令及删除 socket 探测；无数据库迁移。不要把 Unix socket 暴露到公网，跨机应使用官方 TLS/WebSocket 或节点 HTTPS 通道并单独认证。
