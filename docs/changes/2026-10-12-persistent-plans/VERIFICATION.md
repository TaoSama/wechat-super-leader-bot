# 持久计划阶段检查点

日期：2026-10-12。已完成本地固定依赖计划、原子确认授权、派发前资格门禁和真实临时 PostgreSQL/HTTP/WS 验收。**尚未部署，不代表完整自治或所有机器接入已交付**。下方早期记录用于保留回归证据，当前结果见文末。

## 已落盘

- `leader/execution.ts`：不可变计划、一基依赖编号验证、固定请求身份、执行期限、attempt 与 CAS 更新约束。
- `store/interface.ts`、`memory.ts`、`postgres.ts`、`execution-postgres.ts`：五个执行记录 API、每聊天唯一 active、终态不复活、已 claim attempt 不可清除、克隆隔离和有界 keyset 分页。
- PostgreSQL 初始化只增加执行表及索引，不清除执行记录；既有 command 启动语义未改。
- `tests/execution-store.test.ts`：26 项 Memory/模拟 PostgreSQL SQL 路径测试；模拟库不是实际 PostgreSQL 验证。

## 收口时发现的回归

全 Controller 首轮 392 通过、3 失败：新增唯一索引未被旧 SQL fixture 接受；计划 schema 新增 `dependsOn` 默认字段后，原执行器将该编排字段传入严格的命令 schema，导致两项技能确认发送被拒绝。

修复：SQL fixture 识别新增唯一索引；执行器剥离编排字段，不削弱命令白名单。在调度器接入前，提计划和确认两个入口都明确拒绝非空依赖，避免按旧循环忽略依赖而提前发送。新增断言覆盖线上的命令字段不含依赖、提计划拒绝、持久化依赖计划确认不发送。后续实现调度器时必须一起替换两个拒绝门禁与对应验收，不能只删除测试。

## 早期存储层验证（历史记录）

仓库根目录 `/Users/luwentao/Workspaces/wechat-super-leader-bot`：

| 命令 | 结果 |
| --- | --- |
| `pnpm --dir controller test` | 31 文件、397 tests 通过，4.09 秒 |
| `pnpm --dir controller run typecheck` | 通过 |
| `pnpm --dir controller run build` | 通过 |
| `git diff --check` | 通过；大量当前源码为未跟踪文件，不能用该命令代替编译和测试 |

用户会话接入问题另做只读复核：在 `daemon/` 下显式指定当前主任务 ID 和原 IPC socket，运行 `go test ./pkg/codex -run '^TestLiveCodexDesktopReadonlyModelObservation$' -count=1 -v`，1.47 秒通过；settings 与 snapshot 均报告 `gpt-6-astra / openai_http / ultra / active`。没有 Dispatch、resume、重启或修改 transport。既有真实原 owner 发送证据仍引用前轮，不重复发送。

## 早期未完成项

当时调度器、确认后创建持久执行、自然语言进度/取消、允许名单派发复验、后台生命周期、真正 PostgreSQL 并发/重启集成、依赖端到端验证均未完成。此处不是当前状态，后续实现和验证如下。香港及已安装 Daemon 均未更新。

## 当前实现与根因修复

- `execution-scheduler.ts`、`execution-view.ts`、`execution-presentation.ts` 接入确认、查询、取消与 Server 生命周期；最多四步、固定依赖和 24 小时授权。独立执行 CAS 不被聊天查询 revision 抢占。
- 修复确认授权竞态：`confirmExecution` 在同一事务锁定聊天状态、检查完整确认身份和计划，再 INSERT，INSERT 后复验期限。不会在用户取消或 claim 过期后让迟到 INSERT 发布 active。Memory 等价同步；不能用创建后的事务外二次检查替代。
- Server 已接 `CommandService.canDispatchSend`，忙碌/离线/陈旧/路线或技能变化等待，不消耗 attempt；submit 仍复验同一冻结路线。完成回执早于 idle 心跳时不会烧掉后继领取权。
- 独立审查动态复现了领取期间其他步骤转 uncertain/failed 后仍能发下一项的问题。最终 guard 现先复读完整命令视图、依赖完成，再复读执行权限；真实 CommandService + Memory 回归证明零后续发送、保留 attempt、重启不重发。
- 测试审查发现预览后立即确认可能掩盖后台提前创建执行。已补确认前独立查 execution/命令及等待两个真实 tick，不能仅靠即时 wire 计数证明零派发。

## 当前验证

主任务运行，而非仅引用协作结论：

| 命令 | 结果 |
| --- | --- |
| `pnpm --dir controller run typecheck` | 通过 |
| `pnpm --dir controller run build` | 通过 |
| `pnpm --dir controller test` | 34 文件、502 tests 通过 |
| `node test-integration.mjs` | 两轮全部通过，第二轮含强化后的确认前查库与双 tick 负断言；使用新建临时 PostgreSQL 容器、HTTP 模型桩、受控 WS 节点与模拟桌面 socket |
| `node --check test-plan-store.mjs`、`node --check test-plan-confirmation-store.mjs`、`node --check test-plan-execution.mjs` | 全部通过 |
| `git diff --check` | 通过；未跟踪源码另外通过类型检查、构建和测试核验 |

真实 PostgreSQL 证据：

- `test-plan-store.mjs`：双连接创建/CAS 竞争、不可变 attempt/期限、终态、聊天隔离、分页、重新打开连接后的持久记录。
- `test-plan-confirmation-store.mjs`：用 `pg_blocking_pids` 证明实际阻塞在聊天行锁或 INSERT 唯一索引；等待期间 claim/plan 过期、取消、替换确认后均拒绝。INSERT 恢复后跨 TTL 的新行在原事务内回滚，独立查询为零可见行。
- `test-plan-execution.mjs`：实际 Controller tick、HTTP 提计划/确认/查询/取消、WS accepted 回执；completed 由测试显式发送，inspect_turn 不自动完成。验证 accepted 不推进、缺失/错误 turn 拒绝、精确 completed 才解锁、重复确认/回执不重发、同会话等 idle、取消后迟到完成、正常重启只查精确 turn、uncertain 恢复、缺命令的过期 claim 不重发、路线/技能变化等待、allowlist 撤销不复活。
- 原有跨节点 token 隔离、真实 Go Daemon 对模拟桌面大帧/历史/模型/发送链路回归仍通过。

第二轮命令退出 0；测试 harness 正常关闭自己启动的 Controller、Go fixture、模型服务器和 WebSocket，停止自身临时 PG 容器。随后 `docker ps --filter name=super-leader-test- --format '{{.Names}} {{.Status}}'` 无输出；没有停用户服务或清生产数据。

## 仍未证明与交付边界

1. 重启验收为本次测试子进程正常 SIGTERM；崩溃窗口通过持久 claim 注入，不是物理掉电或真实强杀测试。
2. 确认在拿锁与 INSERT 后检查 TTL；最终检查后发起 COMMIT 到实际提交仍有时间窗。派发 guard 到网络写也非原子；取消不保证已领取或原会话运行中的任务停止。
3. 只验证固定内容依赖，不自动传递前项结果、不动态重规划；没有 Web 专门计划视图或微信主动完成通知。本轮模型为协议桩，不替代真实微信/模型验收。
4. 生产 Controller 仍按单一编排权威运行；多存储连接 CAS 测试不是多 Controller 部署支持。PG 启动恢复会清旧 session cache、标记 pending/accepted 为 uncertain。
5. 香港、已安装 Daemon、微信账号状态均未改变。未读真实凭据、未发真实消息、未创建或恢复真实会话、未创建备份；完整目标仍 active。
