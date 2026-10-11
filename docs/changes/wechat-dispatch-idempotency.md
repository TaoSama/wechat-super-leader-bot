# 微信入队与回复失败之间的去重

## 决策与实现

- `WeChatMessage.delivery_key` 传递现有 transport 去重键（账号、聊天、client_id 的 JSON 元组）。不把时间戳作为稳定 ID；mock 和无 client_id 消息默认传空键。
- CLI 将该键传入 `SuperLeader.handle`。路由层在授权之后，根据聊天和 delivery_key 的 JSON 元组计算完整 SHA-256，构造 `wechat-message-` 前缀任务 ID。未知稳定键不影响普通无键调用。
- 成功入队记录本身就是持久化回执，不增加第二套去重数据库，也不在任务写入后再单独提交幂等记录。重放在读取当前绑定和写记忆之前返回原任务 ID 与目标节点。
- 原节点离线、聊天解绑或改绑不改变已成功入队消息的回执。并发最终由 tasks 主键约束仲裁，冲突后读取已存在的任务；不覆盖或重置任务状态。
- 新增 `NodeRegistry.get_task` 做主键查询，避免列出全部任务后过滤。无键请求仍分配随机任务 ID。

## 验证与证据边界

- 最终实测：`.venv/bin/python -m pytest -q` 为 194 passed in 2.11s；`.venv/bin/python -m compileall -q src` 和 `git diff --check` 通过。本轮新增 15 个用例。
- `tests/test_dispatch_dedupe.py` 覆盖普通文本和显式派发、改绑/解绑/离线/终态重放、重新创建应用实例、跨聊天与消息键隔离、无键消息、撤销授权和两个 SQLite 连接并发写入。
- `tests/test_wechat_dispatch_replay.py` 通过真实 CLI 路由入口和临时 SQLite、transport 状态文件，注入发送回复失败，再用新实例重试：任务只有一条、回执一致、成功后游标才提交。并检查无 client_id 不生成键、不同账号键不相同。
- 外部微信请求和 Codex 执行未发生；网络错误是注入值，进程重启用重建实例模拟，没有真实断电/进程崩溃测试或延迟采样。SQLite 主键与 CLI 链路提供独立于 transport 内存去重的验证。
- 只有已经成功入队的远程任务受保护。首次未绑定/离线拒绝没有持久化回执，若该消息后来重放且条件变化，仍可能入队。直接 `/fork`、`/codex`、`/turn`、`/skill` 不受此机制保护。
- 顺序重放跳过重复记忆；并发入站仍可能重复写记忆，但不会产生多个同键任务。回复仍可能重复发送，没有 outbox 或 exactly-once 保证。
- 去重依赖稳定 ID 质量和任务记录保留。同键不同内容按照第一次成功入队的任务返回；需要新任务时必须发送具有新 ID 的消息。旧版本随机 ID 的历史任务不能追溯关联。
- 独立测试子代理两次均返回 `We’re currently experiencing high demand, which may cause temporary errors.`，重试一次后停止，由主 Agent 接手测试；没有独立评审结论。该异常来自开发工具而非微信服务。

## 回退

仅移除本轮 delivery_key 透传、确定性 ID/回执查询及对应测试；不删除已有任务数据，不回滚之前未提交的节点生命周期和结果重试改动。
