# 已确认计划的主动微信通知

## 范围

计划完成、失败或授权到期后，在原发起微信聊天产生一条状态通知。Controller 仍是唯一持久化权威，Gateway 只负责传输；不调用模型、不生成新任务、不改变原会话。此次仅本地实现和模拟微信验收，不部署或真实外发。取消由原请求同步答复；处理中、单步受理和结果存疑不在本轮主动推送，仍可自然语言查询及 Web 查看，不能把本项当成完整自治。

## 冻结契约

1. `compareAndSetExecution` 将 active 转为 completed/failed/expired 时，在同一个数据库事务创建唯一通知；Memory 在同步临界段完成相同动作。通知 ID 使用 execution UUID（每份计划只有一个终态通知），重复 CAS、重启不能另生一条。cancelled 不创建；不扫描旧终态回填通知。CAS 增加可选 `now: number = Date.now()` 参数，调度 transition 传入自身时钟，测试可以固定时间。
2. 通知保存：`id, executionId, chatId, kind: completed|failed|expired, text, createdAt, expiresAt, status: pending|claimed|accepted|uncertain, attemptId?, attemptedAt?, attemptExpiresAt?`。事件有效期 24 小时；文本是服务端生成的有界纯文本，最多 2000 UTF-16 单位，只含计划标识、步数和状态解释，不带原始输出、错误、token、技能正文或一次性登录凭证。完成仅表示计划收到精确完成回执，失败/到期不表示已运行原任务停止。
3. 列表和领取必须使用当前 allowedChatIds 过滤，过滤发生在 LIMIT 前。`POST /v1/notifications/pending` 严格 JSON `{chatIds: string[]}`（最多128项），将 Gateway 已有 context 的聊天与允许名单求交后，返回固定最多 4 条尚未领取且未过期通知，createdAt/id 升序，无 query；返回 `{items: Notification[]}`。空列表返回空；列表不写状态。不按最近计划窗口猜测。每个响应 Notification 为上述白名单记录；只读状态中 pending 过期显示 expired、claimed 过截止显示 uncertain，不重新放回队列。
4. `POST /v1/notifications/:id/claim` 严格 JSON `{attemptId: UUID}`。原子领取仅允许 pending 且未过期、当前聊天仍获准；返回 `{notification: Notification}`，status=claimed，attemptExpiresAt=min(事件 expiresAt, now+60秒)。同一次或另一 attempt 的任何重复领取返回409，绝不能返回可再次发送的成功。领取HTTP不重试；结果不明时不发送。attempt 永久保留，崩溃/超时都不自动重领。
5. `POST /v1/notifications/:id/receipt` 严格 JSON `{attemptId: UUID, status: accepted|uncertain}`。仅允许相同 attempt，幂等记录；accepted 不可降级，uncertain 可由同 attempt 的明确成功回执升级 accepted。可保存撤销名单后或超时后的既有发送证据，但不授予新的发送权。返回 `{notification: Notification}`。`GET /v1/notifications/:id` 是 Bearer 管理只读，便于核查结果；Cookie 和节点 token 对所有通知接口均拒绝。所有接口沿用 no-store，未知记录404，领取冲突409。
6. Gateway 新增明确开关 `--plan-notifications` / `GATEWAY_PLAN_NOTIFICATIONS=true`，默认关闭，check/healthcheck/baseline 均不发。仅 baseline 已完成时可处理；每轮最多4条、单飞，列表仅提交已有非空 context 的聊天，超过128个时按排序轮转批次（下轮续查，内存游标即可），避免缺少 context 的旧通知挡住其他聊天；无context不调用列表。领取成功后再检查完整身份、text预算、截止、stop 和 context，最多调用一次 `sendSingleText`。使用确定 clientId `super-leader:notification:<id>` 关联证据，但不宣称微信端幂等。
7. 发送需得到显式成功回执（ret 或 errcode 明确为0，且所有出现的错误码均为0）；空对象/坏数据/超时/网络错误均视为 uncertain，不自动重发。为此允许在现有 `sendSingleText` 复用传输时加入通知专用严格回执选项，不改变普通回复语义。accepted 指微信接口受理，不证明用户已收到或已读。回执提交可有界重试同一请求，不再次触发外发；失败时原 claim 留在 Controller 可核查。
8. runLoop 在每次入站 poll 前执行一次有界通知处理，错误独立报告、继续入站轮询；poll-once 在普通入站周期成功后按显式开关再执行一次。无新后台 timer；繁忙入站和长轮询可能推迟下轮通知。stop 后禁止开始新的领取/发送。通知复用健康 processing 阶段，整轮预算235秒，不虚增成功轮询或入站计数；以内存 phase revision 只清理自己登记的阶段，超过预算仍失败。每次通知 HTTP 请求结束均释放截止监听、reader 锁并 abort 未读响应，不因非2xx/解析失败遗留连接。更新不清原微信游标、context、去重记录或 journal。
9. 当前允许名单复核与外部网络写仍非原子；撤销与已领取发送竞争存在有界窗口。一次尝试策略会在“已领取但未发送即崩溃”时漏发，必须明确 uncertain 而不是重放；不保证 exactly-once 或必达。不将过期聊天 context 误称为可主动触达的永久通道。

## 写入所有权与验证

- Controller 协作：仅 controller/（schema/store/事务 outbox/router/scheduler 接线/单测）。存储公开方法固定为 `listPendingNotifications(chatIds, now)`, `getNotification(id, now)`, `claimNotification(id, attemptId, chatIds, now)`, `recordNotificationReceipt(id, attemptId, status, now)`；返回 Notification 或 null（列表除外），冲突抛 ConflictError。
- Gateway 协作：仅 gateway/（client/发送/显式CLI开关/循环/离线测试）；不改真实配置/状态。新增 `deliverNotificationsOnce()` 返回 `{accepted, uncertain, skipped}`，供整链验证复用。
- 主任务：集成脚本、运维模板与文档、独立审查、真实临时 PG + HTTP + 模拟 iLink 整链；不访问真实微信。
- 必测：终态与通知事务原子性、单胜并发领取、同 attempt 重复409、固定身份、Cookie拒绝、名单撤销、过期不领、重启不重放、响应丢失不重发、严格send回执、无context不消耗、默认关闭/基线不发/stop、回执幂等与迟到成功、原入站仍工作、清理临时进程/目录/容器。
