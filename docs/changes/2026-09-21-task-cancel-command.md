# 取消未领取的远程任务

新增 `/cancel <任务ID>`。NodeRegistry 仅允许将 `queued` 任务改为 `cancelled`，并按 owner_chat_id 隔离微信聊天；已被节点领取的 `running`、状态不确定的 `uncertain` 和终态任务保持原状态，避免控制面回复与实际执行不一致。HTTP/节点内部可调用无 owner 的全局取消 API，但 CLI 微信路径始终带当前聊天归属。

## 验证与证据边界

新增测试覆盖：已领取任务不取消、其他聊天任务不可取消、同聊天未领取任务可取消；全量 `.venv/bin/python -m pytest -q`：402 passed in 3.36s；compileall、git diff --check 通过。节点领取和 SQLite 使用替身/本机数据库，没有停止真实节点或发送微信。取消只改变控制面队列状态，不会中止已经运行的 Codex 进程；没有性能推算。

回退移除命令和 `cancel_task` 即可，无数据库结构迁移。
