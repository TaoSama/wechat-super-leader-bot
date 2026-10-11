# 计划终态通知验收

日期：2026-10-12。范围为本地源码、临时 PostgreSQL、真实 HTTP/WS 与模拟微信传输；没有更新香港服务、已安装 Daemon、微信账号或真实 checkpoint，没有向微信外发。完整目标仍未完成。

## 交付

- Controller 将计划 active → completed/failed/expired 与唯一通知放在同一事务，cancelled 无新增通知，旧终态不回填。固定文本只包含计划 ID、总步数、状态解释。
- 四个 Bearer-only 通知接口；列表先做有 context 的聊天与当前允许名单交集、再 LIMIT 4。事件有效期24小时；永久单次领取，领取期60秒。同 attempt 重领也返回409。
- Gateway 显式 `--plan-notifications` / `GATEWAY_PLAN_NOTIFICATIONS=true`，默认关闭。基线/check/healthcheck 不发送；已有 context 超过128时轮转，缺 context 的旧通知不阻塞其他聊天。
- claim HTTP 零重试；领取后复验完整身份、正文、context、账号、截止、stop。外发至多一次，微信缺失明确成功码时记 uncertain，不重发。只有上传既有回执可最多3次相同请求。
- 复用235秒有界健康 processing 阶段，不虚增入站成功/计数；phase revision 避免通知 finally 清掉并发入站状态。HTTP 异常/流式错误/解码失败也释放请求和监听。
- Compose 模板默认 false；启用、核查、停用与限制已写入 [香港运维说明](../../runbook/hong-kong.md)。

实现入口：`controller/src/notifications.ts`、`notification-routes.ts`、`store/notification-postgres.ts`、`store/execution-postgres.ts`、`store/memory.ts`、`leader/execution-scheduler.ts`；`gateway/src/notifications.ts`、`notification_client.ts`、`gateway.ts`、`ilink.ts`、`health.ts`、`index.ts`。接口转发保留单一实现，无旧版兼容入口。

## 主任务独立验证

| 命令 | 最终结果 |
| --- | --- |
| `pnpm --dir controller test` | 38 files / 538 tests PASS，exit 0 |
| `pnpm --dir controller run typecheck` | PASS，exit 0 |
| `pnpm --dir controller run build` | PASS，exit 0 |
| `pnpm --dir gateway test` | 104 tests PASS，exit 0 |
| `pnpm --dir gateway run build` | PASS，exit 0 |
| `node --test deploy/gateway.test.mjs` | 4 tests PASS，exit 0 |
| `node test-integration.mjs` | 两轮 PASS，exit 0；最终一轮包含严格正文核对及最终 Gateway 构建 |
| `node --check test-notification-store.mjs` | PASS |
| `node --check test-plan-notifications.mjs` | PASS |
| `node --check test-integration.mjs` | PASS |
| `git diff --check` | PASS；本轮新增文件另查尾随空白 |

本輪未改 Web/Daemon 业务代码，不重复主张本轮浏览器或真实会话实发通过；整链仍执行真实 Go Daemon 对模拟原桌面 socket 的回归。之前 Web 的276项及浏览器证据保持在 [计划视图验收](../2026-10-12-plan-console/VERIFICATION.md)。

### PostgreSQL 独立证据

`test-notification-store.mjs` 使用两个独立 Store 和真实临时 PG：

1. 竞争终态 CAS 只有一个胜者、同 execution 只有一条通知；active/cancelled 无通知，文本不包含私有 prompt sentinel。
2. 临时 CHECK constraint 强制 outbox INSERT 失败，验证前面的终态 UPDATE 一起回滚；移除约束后同计划正常保存终态和通知。
3. 两客户端竞争 claim 只有一个成功；重复同 attempt、空允许名单、错误 attempt receipt 均拒绝。
4. claimed 到期只读投影 uncertain，不能重领；同 attempt 迟到 accepted 可恢复，重复幂等，accepted 不降级。
5. 24小时 pending 过期不可领；禁止聊天的旧记录不占四条窗口，createdAt/id 稳定排序；重建客户端保留永久 attempt，不重放。

实际输出：

```text
PASS real PG terminal/outbox atomic rollback, one terminal event, concurrent permanent claim, late exact receipt, TTL, filtered bounded order and reopen without replay
```

### 真实 Controller/Gateway + 模拟微信

`test-plan-notifications.mjs` 直接使用已构建的 StateManager、ControllerClient、ILinkClient 和 WeChatGateway，真实 HTTP 访问临时 Controller/PostgreSQL。只替换 iLink fetch，限定唯一 `.invalid` endpoint、synthetic账号/context/聊天，拒绝任何其他外发地址。

- 已确认依赖计划收到精确完成回执后自动产生 completed 通知；撤销名单导致 failed；cancelled 返回404，无额外通知。
- 管理 Bearer 可读写；实际签链接兑换的 Cookie 对四接口全部401，最后退出登录。
- 无 context 不领取、显式关闭不发送；两 Gateway 竞争无重复 clientId。
- 模拟传输逐字校验单条纯文本 item_list 等于数据库通知正文，且发送前已持久 claimed。
- claim 已提交后响应丢失：只请求一次、零外发，Controller/Gateway 重启不重放。
- 微信空回执/提交后断线：仅一次外发，uncertain 后不重试。
- receipt 已保存后响应丢失：2–3次同 payload 记录，外发仍只有一次。
- 允许名单撤销后列表空/claim409；恢复后只发送尚未领取的 pending。

实际输出：

```text
PASS exact completed plan → durable notification → actual Gateway/HTTP → simulated WeChat; cookie denied, no-context/default-off preserved, concurrent sends unique
PASS notification claim-response loss, empty/unknown send result, receipt-response loss, allowlist revoke/restore and Controller/Gateway restart: no external replay
```

严格 schema、四接口节点 token 拒绝、默认缺省关闭、stop/基线/账号改变、128聊天轮转、入站错误隔离、健康预算、10秒请求截止/64KiB正文上限及连接释放分别由 Controller/Gateway 单测补充，不用模拟结果冒称真实微信验证。

## 审查闭环与经验

按编排技能仅复用两个现有协作单元，分别拥有 Controller 与 Gateway；主任务独立复跑最终构建与整链。主任务按代码审查技能进行限定通知改动的单遍核查，没有运行完整多 Agent 审查矩阵；另由既有 Controller 协作单元只读审查主任务集成脚本。

审查发现并修正：

- 通知阶段可能超过120秒旧健康窗口：复用235秒有界 processing，并用 phase revision 避免清错其他阶段；不伪造 poll success。
- 非2xx响应及解码异常可留下未读 body：统一请求 finally abort，并验证 reader锁/截止监听均释放，重试前释放前一请求。
- 测试临时目录后的账号初始化原在 try 外：移入 finally 覆盖范围；mock传输新增持久正文精确对照。

最终上述发现已修正并回归；未解决的产品边界列于下节，不隐去。建议后续开发约定补充“持久副作用分离领取授权与结果证据”“异常响应必须释放传输资源”“慢链路健康期限不得伪造成功”。本轮没有修改全局 CLAUDE、rules 或 skills。

## 清理、停用与未证明事项

- 两轮整链脚本 exit 0；自己启动的 Controller、模拟模型 HTTP、Go fixture 和临时 PG 正常退出。`docker ps -a --filter name=super-leader-test-` 返回空。
- 临时 `super-leader-notification-test-*`、`gateway-notifications-*` 目录检查为空；只删除测试合成状态，无真实数据，不创建备份。两个本轮协作单元均已完成。
- 原数据库、微信 token/context/cursor、Daemon journal、用户会话和运行服务不变；未提交、推送或部署。没有新建或恢复任何验收 Task。
- 本地关闭开关即停止开始新的通知领取/发送；已开始的网络写可能已受理，不能撤回。不要删除通知记录或重建基线来“重试”。重新开启时既有未过期 pending 可能发送，先确认范围。
- 香港 Controller/Web、已安装 Mac Air Daemon 的更新仍待确认；本功能还需同步更新 Gateway 并显式启用。真实微信 context 有效期、用户送达/已读、手机体验尚未验证。
- claim 后崩溃可能漏发，结果不明不重放；允许名单与网络发送无法原子提交。`accepted` 不是“用户已收到”，不保证必达或 exactly-once。
- 通知只覆盖 completed/failed/expired，不包含每步受理/处理中/uncertain推送；取消/失败/到期不表示原会话停止。持续动态自治、跨会话结果传递、其他独立 CLI 与其他机器的控制能力仍有缺口，完整目标保持 active。
