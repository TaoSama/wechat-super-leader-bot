# 持续目标主动微信通知

新增目标通知复用既有持久 outbox 和投递机制。Controller 是唯一事件生成权威；Gateway 只传递静态摘要。发布及验证状态见同目录 VERIFICATION.md，不凭代码存在声称已经上线。

## 事件和状态

- 固定计划保持 active→completed/failed/expired，cancelled 不通知。
- 持续目标只在 active 首次转为 completed/blocked/expired 时，在同一次 CAS 事务保存唯一通知。cancelled 不通知；blocked 随后 cancelled/expired 不再生成第二条，不修改首次事件和领取记录。
- 摘要不包含 objective、条件、原任务、结果正文、模型理由、私有错误或登录链接。目标 completed 明确“模型根据精确完成记录判断条件已满足；这不是独立业务验收”。blocked/expired 说明停止后续不代表原会话任务停止，提示查询当前状态。通知是发生过的事件，不是持续更新的状态快照。
- 不回填上线前的终态目标或计划。不为测试修改既有 completed/uncertain 记录。

## 唯一数据合同

通知 JSON 使用 `source: {type: "plan" | "goal", id: UUID}`，并要求 `notification.id === source.id`；不再提供 executionId 字段或旧协议兼容入口。type/kind 严格匹配，Gateway 的列表、领取及回执身份复核包括 source。

同一 `leader_notifications` 表保留 nullable execution_id FK，并新增 nullable goal_id FK；两者恰一非空、分别唯一，id 必须等于该来源 ID，kind 受来源约束。初始化顺序先创建两类来源表，再处理通知。旧数据在同一个初始化事务严格校验后仅将 JSON 的 executionId 转为 plan source；attempt/status/time/text 保留。非法数据使整个事务回滚，不静默删除或修复。

## 投递不变量

仍为事件 TTL 24h、claim 60s、永久单 attempt、最多一批4条；只处理 Gateway 已有 context 与 Controller allowlist 的交集。无 context 不领取，列表/领取/微信外发不重试；receipt 仅允许同 attempt 有界重试。结果不明保留 uncertain，不再发送；accepted 只表示微信 API 受理，不保证人收到。领取后崩溃可能漏发，不宣称 exactly-once。Cookie/节点身份不能使用管理通知接口。

统一开关为 `GATEWAY_NOTIFICATIONS=true` / `--notifications`，默认关闭，不保留旧开关别名。只给 Gateway 注入，不给 Controller 额外发送权限。

## 发布顺序与回退边界

1. 本机/CI 构建并验证 Controller 和 Gateway 镜像，香港只加载产物。
2. 审计全部命令、聊天 claim/pending、目标/计划和通知，保留旧通知精确 attempt。正常停唯一 Gateway，不改微信基线、state/cursor 或凭据；不能两份并行轮询。
3. 排空 Controller，记录旧容器/镜像及非敏感配置摘要。在相同数据库上启动新 Controller，迁移完成后核验每条旧通知只发生合同转换、旧终态未回填。
4. 精确把项目私有 env 的旧通知开关改为新开关，保留其原布尔值和其他字段；更新为同合同 Gateway，正常启动原 state 挂载，复核健康及唯一实例。
5. 源合同变化后不能直接回退旧 Controller/Gateway 二进制；旧 Gateway 会拒绝新 JSON。迁移失败会回滚 DB，可继续旧版；迁移成功后的运行问题优先同合同修复或关闭通知保留状态，不通过删除记录、反向修改 attempt 或重建登录恢复。任何人工逆向数据迁移需另行明确方案。

正式新目标通知验证需要真实新授权和原会话执行，不拿旧 completed 目标造通知。合成微信整链与真实手机验收分开记录。
