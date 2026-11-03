# 后台定时任务正文更新

已创建的后台定时任务可持久修改 `background.prompt`。来源任务、定时规则、时区、
观察窗口、复查间隔和历史结果保持原值，不会向源会话派发指令或重跑任务。
仅允许编辑 `kind=background` 且状态为 active/paused 的任务；存在 `activeRunId`
时返回 409，等待当前轮次自然结束后再操作。已有 worker 使用其原正文，未来新轮次使用新正文。

微信工具调用必须由当前真实用户消息明确授权 `automationOperations: ["edit"]`。
先读取任务，取 `latestPromptUpdate.revision`（字段不存在时为 0），再提交：

```json
{"id":"<schedule UUID>","prompt":"<完整新正文>","expectedPromptRevision":0}
```

原来的 `{"id":"<schedule UUID>","status":"paused"}` 等状态操作继续可用。
两种参数不能混用；正文编辑不会暂停、恢复或取消任务。正文 trim 后须为 1～128000 字符。

## 管理 API

使用现有 Controller 管理 Bearer 和允许的真实 chatId：

```http
GET /v1/automations/<schedule UUID>?chatId=<URL编码的真实chatId>

POST /v1/automations/<schedule UUID>/prompt
Authorization: Bearer <管理token>
Content-Type: application/json
Idempotency-Key: <本次管理请求的稳定标识>

{"chatId":"<真实chatId>","prompt":"<完整新正文>","expectedPromptRevision":0}
```

示例中的版本值须替换为刚读取的正文版本。成功返回 `{schedule}`；归属不符返回 404，
参数非法返回 400，权限不足返回 401/403，活动轮次、终态或版本冲突返回 409。
Console Cookie 不允许调用正文更新接口。管理请求独立记录为 `source=admin_api`，
不冒充微信入站；原创建 `authorizedMessageId` 和创建幂等身份始终保留。

每次实际正文变化递增 `latestPromptUpdate.revision`，同时保存实际 source、requestId 和时间。
状态变化及轮次完成不会修改正文版本。只对最后一次已应用编辑提供精确重试：
相同来源、请求标识、原预期版本和规范化正文返回已保存结果，不再次写入。
管理请求不能用相同的最后请求标识更换正文或版本；同一真实微信轮次可使用新版本继续明确授权的编辑。

版本过期且不满足上述精确重试时返回 409。不得自动获取新版本覆盖别人的修改。
新请求以正确版本提交相同正文时不修改、不递增版本，也不占用该请求标识。
这里只保留最后一次编辑记录，不提供所有历史管理键的永久去重表。

超时或断线时先 GET 回读，必要时使用完全相同的请求标识、正文和预期版本重试，
不要换标识盲目重发。回滚正文也通过此接口，使用新管理请求标识、最新版本和审核过的旧正文，
不恢复旧审计字段、运行状态或整行数据库。
