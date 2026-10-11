# 微信聊天绑定 Codex Task

新增独立 `chat_threads` 持久化表及 `/use`、`/unuse` 命令。每个授权聊天最多绑定一个 thread_id；绑定后普通文本优先调用共享 app-server 的 `thread/resume` + `turn/start`，并返回 `thread_id`。远程节点 `/bind` 保持原表和语义，解除 Task 绑定后才回退到远程节点；两类目标不会互相覆盖。

绑定不会在写入时启动或恢复 app-server，也不会读取凭据；不存在的 thread 会在实际发送时返回 Codex 错误。这样扫码测试可先从 `/threads` 取 ID，再 `/use <ID>`，无需每条消息重复输入 `/turn`。

## 验证与证据边界

新增 2 个生命周期测试：绑定跨 SuperLeader 重启保存、普通文本路由、解除持久化，以及 Task 绑定优先于节点绑定。全量 `.venv/bin/python -m pytest -q`：394 passed in 2.94s；compileall、git diff --check 通过。

发送使用替身 `desktop.send_turn`，未连接真实 Codex 桌面 Task、微信或跨机节点；因此只证明本地路由和 SQLite 持久化，不证明模型执行。Task 文本暂未使用 message_id 去重，重放风险已在 runbook 明示。没有性能推算或外部接口调用。

回退可移除 `chat_threads` 表访问、三个命令和对应文档；已有 `chat_routes` 数据不受影响。
