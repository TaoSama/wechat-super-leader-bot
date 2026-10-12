# 目标通知验收

日期：2026-10-13（Asia/Shanghai）。设计见 [TECH.md](TECH.md)。本文件区分开发验证、正式发布及手机收取；不得用模拟微信冒充真实外发。

## 当前交付

- Controller 对目标 active 首次转 completed/blocked/expired，在同一 CAS 事务插入通知；取消不通知，blocked 后到期/取消保留首次事件。
- 计划/目标共用 outbox、管理 HTTP、TTL、永久领取及回执；唯一来源合同 source(type,id)，不保留旧 API 或开关兼容。
- 旧记录事务迁移 executionId→source(plan)，其余状态、attempt、文本与时间不变。目标终态不回填。
- Gateway 开关统一为 GATEWAY_NOTIFICATIONS / --notifications，默认关闭；解析/领取严格比较来源，不重复微信发送。

## 开发验证

最终 `node verify.mjs --suite unit`：PASS 13 checks，包含四组件测试/构建、CLI 工具、Go race/vet/跨平台构建。Controller 59 文件、882 项测试及 Gateway 130 项测试均通过。`node verify.mjs --suite integration`：PASS 6 checks，已包含最终新增的真实 PG 外键和来源约束断言。`git diff --check` 通过。

真实临时 PG 验证覆盖：旧 schema 四种通知状态及完整行逐字段保留；最后一行非法时前面已转换 JSON 与 DDL 全回滚；重复 init 不变；旧 expired goal 不回填；source XOR/id/kind/FK 约束。目标 outbox 插入失败回滚状态；双连接 CAS 与 claim 各一个赢家；blocked→expired 保留原 uncertain attempt；取消静默；跨聊天隔离与重连不重领。

整链使用真实 Controller HTTP、模型协议桩、WS 精确完成回执、临时 PG 与真实 Gateway 类；微信 fetch 只允许合成 .invalid 端点。目标 completed 必须来自两步执行/决策链，不伪造完成记录。已验证持久通知先领取再外发、无 context/默认关闭不领取、取消静默、丢回执后 uncertain、Controller/Gateway 重启不重发。临时 PG 和合成状态目录由验收脚手架清理。

独立协作者审查 Controller 迁移/CAS、Gateway 严格合同与根测试断言，未发现高置信阻断问题。该审查不代替执行结果或生产安全保障。

## 正式发布与限制

本通知增量尚未发布。现有香港 Controller/Web `08e260a`、Gateway `3a750e7` 不变；旧唯一通知 uncertain，同 attempt，不补发。Air 的真实持续目标两轮结果见 [独立证据](../2026-10-13-live-goal/VERIFICATION.md)，它在通知实现之前完成，不会因升级补发通知。

尚未证明：新目标通知的真实微信 API 受理或用户手机收取。accepted 仅代表接口受理，不是送达或已读；claim 后崩溃可能漏发。文案仅静态事件，当前状态需查询。
