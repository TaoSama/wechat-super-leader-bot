# 节点结果状态转换

带 node_name 的节点回传只允许 running/uncertain 转入 completed/failed/cancelled；不能自行 queued/running，未领取任务也不能直接报完成。
完全相同的终态和结果可重复确认；不同结果不能覆盖已存终态。条件 SQL 更新保证不同数据库连接竞争时仅第一个终态写入成功。

验证：`.venv/bin/python -m pytest -q` 实测 118 passed；compileall、git diff --check 通过。新增 4 个用例覆盖三类终态、重复确认、跨节点拒绝、未领取拒绝及双连接竞争。原先跳过领取的两处测试已补齐流程。

证据边界：仅本地 SQLite，不执行真实模型、不发送外部消息。无 node_name 的进程内管理调用保留原权限；HTTP 路径始终传已鉴权节点名。执行代次隔离、持久化结果补报仍未实现；拒绝转换当前沿用 HTTP 404，尚未区分状态冲突和任务不存在。
