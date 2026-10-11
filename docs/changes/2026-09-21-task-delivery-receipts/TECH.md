# 绑定 Task 的消息回执去重

绑定 Codex Task 的普通文本现在也支持稳定 `delivery_key` 去重。MemoryStore 新增 `delivery_receipts` 表，按 `(chat_id, delivery_key)` 保存成功的回复文本和结构化 data；进入 Task 路由时先查回执，发送成功后保存。失败不写回执，下一次可重试。SuperLeader 用进程内锁包住“查回执—send_turn—写回执”，减少同一进程并发重复 turn；SQLite 主键和 INSERT OR IGNORE 保证保存幂等。远程 `/dispatch` 既有任务表去重逻辑不变。

## 验证与证据边界

新增回归测试：同一稳定 key 调用两次只执行一次 `desktop.send_turn`，返回相同 data；全量 `.venv/bin/python -m pytest -q`：400 passed in 2.90s；compileall、git diff --check 通过。测试使用替身，不调用真实模型或微信；此前真实 iLink 稳定 client_id 解析测试只证明 key 构造，不证明平台重放语义。

回执没有过期清理、大小上限和跨聊天迁移；delivery_key 为空时不去重。进程崩溃发生在 turn 成功与回执提交之间仍可能重复执行，这是需要服务端幂等/turn ID 或 outbox 才能消除的窗口。没有性能推算，耗时是单次观测。

回退移除表和路由分支即可；已有 memories/chat_routes 数据不受影响。
