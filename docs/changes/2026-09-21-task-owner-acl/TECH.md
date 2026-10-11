# 微信任务按聊天隔离

tasks 表新增可空 `owner_chat_id`（启动时对旧数据库做增量 ALTER）。SuperLeader 从微信 `/dispatch` 和绑定节点的普通文本写入当前聊天 ID；`/tasks` 分页和 `/task` 详情按 owner 过滤，避免一个授权聊天读取另一个聊天的新任务。HTTP/节点内部管理调用不传 owner，仍保留全局运维视图。旧任务 owner 为空时保持兼容可见，不假装已完成历史迁移。

## 验证与证据边界

新增生命周期测试：聊天 a、b 各派发一项，a 的 `/tasks` 不出现 b 的 ID，a 读取 b 的 `/task` 返回未找到，b 仍可读取自己的任务。全量 `.venv/bin/python -m pytest -q`：401 passed in 12.52s；compileall、git diff --check 通过。测试为本机 SQLite/替身节点，不验证多租户 HTTP 身份系统或真实微信；旧 owner=NULL 兼容策略是明确推导，不是历史数据实测。没有性能推算。

任务 owner 不是节点身份 fencing，也不限制节点管理员数据库访问；若未来需管理员在微信查看全局任务，应增加显式管理员命令而非绕过 owner。回退删除列过滤和迁移即可；SQLite 旧数据不会丢失。
