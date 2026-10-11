# 已确认计划的持久依赖编排

本轮继续完整 Super Leader 目标，不部署、不创建真实会话或发送真实消息。将原先最多四个独立 actions 的确认后循环扩展为持久依赖执行；新能力仍操作既有原会话，不引入隔离 worker。完成门槛为自然语言提计划/确认/查询/取消、持久依赖推进及真实临时 PostgreSQL 集成；不将本项等同全体机器、CLI 或完整自治已交付。

## 冻结契约

1. actions 增加 `dependsOn`，使用预览中的一基步骤编号，只能引用更早步骤，不允许重复、自依赖、越界或环；数组顺序随确认冻结。重复会话目标必须通过传递依赖串行化。修改顺序/内容必须新 UUID、新预览、新确认，不引入版本兼容分支。
2. 独立 `leader_executions` 持久记录：id 等于计划 UUID，chatId、revision、原 plan、createdAt、expiresAt、status、每步 attempt。与聊天状态分开，聊天查询不抢调度所有权。每聊天最多一个 active 执行；命令与已结束执行保留。
3. 预览明确 10 分钟确认时限及确认后 24 小时自动推进授权窗。确认冻结 node/session/prompt/skills digest/sendRoute/dependsOn；模型不能为已确认执行改写、重试或增派任务。确认时仍验证全部目标/路线/技能可用，后续每次派发重新验证。生产创建只调用 confirmExecution：同一 PG 事务锁定聊天状态，拿锁后核验 revision、inflight 身份、完整冻结 plan、claim/plan/执行期限；INSERT 后再次取时钟复验才 COMMIT。Memory 采用同步临界段。普通创建仅为底层存储 primitive，不是模型/HTTP 确认入口。确认授权的线性化边界是最终检查后发起 COMMIT，不保证提交完成时刻严格不晚于 TTL。
4. requestId = hash(chatId, plan UUID, 冻结步骤编号)。先调用 CommandService 的只读资格检查：离线、忙碌、陈旧观测、路线或技能版本变化先等待，不消耗 attempt、不自动换路；资格恢复后仍需真正 submit 的二次复验。CAS 必须在提交之前持久化唯一 attempt token（15 秒派发窗口）；已有 attempt 永不清除或再次提交。发送前 callback 复核全计划 command 的 failed/uncertain、前驱精确完成，再复读 active/期限/allowlist/同 attempt token；CommandService 再复核最新资格/固定路线。多个调度者争同一步只允许一个 CAS 胜者。
5. 崩溃发生在 claim 与 command 创建之间时，无命令记录也不能假设没发送；claim 到期显示 uncertain，不自动重试。已有命令按精确 requestId/目标/内容/技能/路线核对，只读复用；accepted/pending 不是完成，必须 completed 且有合法 turnId 才满足依赖。uncertain 暂停后续；精确回执恢复 completed 后可以继续已授权后继，不重发前项。failed 停止后续。
6. 调度每 2 秒、有界分页 8 条、单飞循环，服务启动从持久状态恢复，停止时 join 当前工作后再关闭 Hub/store；集合较大时每项并非恰好每 2 秒处理。无需 LLM 持续轮询或生成后继内容，用户随时可自然语言查询当前计划。waiting 表示依赖或固定目标的发送资格未满足，不伪称原任务已经启动。
7. 取消仅阻止后续派发，不停止已运行的原会话。取消与 claim 对同执行 CAS，派发 callback 再校验；与最终网络写之间仍有非原子窗口，已 claim 的项必须展示为可能已发送，不能声称已被杀掉或绝对零发送。取消后的迟到完成不能启动后继。
8. 未完成的跨会话结果传递/动态重规划、Web 专门计划视图、全部宿主/CLI 和微信实测继续保留在总验收，不以固定依赖图替代完整目标。

后续同日增量：专门的 Web 已确认计划视图已在本地实现并验收，尚未部署；该条其余缺口保持不变。当前范围与证据见 [计划视图设计](../2026-10-12-plan-console/TECH.md) 和 [验收记录](../2026-10-12-plan-console/VERIFICATION.md)。

## 写入所有权

- 主任务：contracts/execution 类型契约、自然语言接线、server 生命周期与 API、真实集成入口、文档。
- 持久层协作：IStore、Memory/Postgres 独立 execution 持久化与测试，禁止修改调度器。
- 调度协作：execution scheduler 与单元测试，禁止修改 store/contracts/server/现有 orchestrator。

主任务独立运行 typecheck、测试、构建、真实临时 PG/HTTP/WS；确认前零发送、accepted 不推进、exact completed 才推进、跨聊天/重复/重启/未知结果/取消/资格变化均必须有断言。测试不连接微信或真实 owner。
