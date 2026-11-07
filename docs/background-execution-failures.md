# 后台执行失败诊断

一次跨机器汇总有三个独立结果：源任务是否完成、后台汇总是否成功、结果是否投递。源日报 `completed` 并不保证后台汇总成功；失败提醒进入结果队列也不表示日报已经送达。Gateway 确认全部分段只表示微信接口受理，不代表用户已读。

## 认证错误

Claude Code 原生 assistant 事件同时包含 `error=authentication_failed` 和 API 错误标志，且最终 result 为 `is_error=true`、`terminal_reason=api_error`、进程正常退出或退出码为 1 时，执行器记录 `worker_authentication_failed`。兼容 stream 的 `is_api_error_message` 与历史 transcript 的 `isApiErrorMessage`；普通正文或工具返回中的同名文字不参与分类。即使 result 的 `subtype=success`，也必须检查 `is_error`。

执行器等待最终结果后判定：后续有效成功结果仍按成功处理，后续其他 assistant 错误不会被先前认证错误覆盖。中断、输出损坏、收据保存失败和子进程清理不确定仍按各自错误处理。

认证失败保持 `needs_attention`，服务将本轮汇总记为失败并通过原结果队列发布失败说明。源任务的已完成观测保持原样，重复查询及服务重启不会自动重跑原 invocation。账户被暂停或封禁时，由账户持有人按服务商支持流程处理；错误分类不能证明账户恢复。

## 安全日志

仅在服务成功保存失败终态后，输出一条 JSON 事件：

```json
{
  "event": "background_worker_failed",
  "runId": "<run UUID>",
  "workerId": "<worker UUID>",
  "invocationId": "<invocation UUID>",
  "category": "authentication_failed",
  "executionEvidence": "unverified"
}
```

`category` 使用固定白名单，未知错误归为 `execution_unverified`。日志不包含服务商原文、凭证、工具输入或原始异常；更早发生的 runtime 错误只输出通用提示，不声称终态已经保存。

| executionEvidence | 含义 |
| --- | --- |
| `tool_activity_observed` | 原生事件出现工具调用或结果；仍需核对外部影响 |
| `unverified` | 工具执行及外部影响尚未核实，不能推断为未执行 |
| `not_started` | 仅用于已确认启动前取消的回执 |

`worker_expired` 可能来自停止正在运行的 invocation，因此仍为 `unverified`。认证失败无论是否观察到工具活动，都不自动重放。

## 隔离验证

```sh
pnpm --dir controller build
node tests/integration/leader/background-auth.mjs --run
```

入口启动实际 Controller，通过认证 HTTP API 创建计划，让 scheduler 只读观察合成源任务，再启动受控 Claude 可执行文件，最后检查 run、公开任务详情、结构化日志和结果队列。覆盖认证失败、工具活动后认证失败、普通失败、认证错误后成功和正常成功；核对源观测仍为 `completed`、失败结果不误作日报、重复查询不重跑，以及凭证和服务商原文不外泄。

原生认证事件形状另以 Claude Code 2.1.316 连接本机合成 HTTP 403 服务核对。上述验证不调用真实模型、微信或用户会话；集成入口模拟 Claude sandbox posture，不作为沙箱安全边界的验证。它已接入 `scripts/verify.mjs` 的 integration 分组。
