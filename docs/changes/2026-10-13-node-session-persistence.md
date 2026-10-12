# 节点会话快照并发修复

## 现场与根因

2026-10-13 远端发布自然语言历史查询后，运行日志持续报告 `23505 / node_sessions_pkey`，调用链为心跳 → `PostgresStore.upsertNodeSessions`。当时状态接口的 19 个 `(nodeId, sessionId)` 没有重复；模型查询失败另有 `toolCalls=0` 的 timeout/transport 证据，不能把两类问题归为一因。

WebSocket 的异步消息处理器没有顺序等待。同一节点 hello 提前设置握手完成后，heartbeat 可以重入。原存储执行 `BEGIN → DELETE 整节点 → INSERT 所有会话 → COMMIT`，却没有节点锁；两个事务的 DELETE 快照可看不到另一个事务稍后插入的行，随后 INSERT 发生主键冲突。单纯 ON CONFLICT 不能维护整批快照语义，可能保留新旧会话或错误能力的混合集合。

## 修复合同

- Hub 只对每节点快照持久化和完整断连清理排队；不同节点独立，历史及精确回执处理不等待该队列。内存里的最新会话/能力仍即时替换。
- 排队快照在执行前复核精确节点对象和 socket，旧连接遗留快照不覆盖新一代。断连删除、代际检查和 uncertain 标记作为完整队列项，新连接快照排在其后。
- `closeAll()` 等待所有节点队尾，包括已从在线集合移除的节点，再允许存储关闭。独立审查曾以双屏障复现旧版本提前返回，最终回归要求同时等写入和 uncertain 标记结束。
- PostgreSQL 以带命名空间的节点 ID 取得事务级 advisory lock，覆盖整批 replacement 和 remove；跨 pool/client/store 实例仍串行。DELETE 与全部 INSERT 同事务，失败回滚释放锁；不改 schema、持久会话内容或历史数据。
- 冲突的重复会话 ID 不能靠“保留第一条/最后一条”决定权限。Hub 拒绝非法 inventory、撤销缓存并关闭连接；两个 Store 在写入前明确拒绝，保留先前完整快照。

只修改 Controller 的快照一致性与关闭生命周期；没有改 Daemon、Web、Gateway、发送资格、原生连接方式或模型 API。

## 验证与发布

新增 `controller/tests/node-session-concurrency.test.ts` 的 8 项回归覆盖重入、独立节点、旧连接排队写丢弃、重连清理、两类 shutdown、失败后恢复和重复 ID。独立评审 `findings=[]`；其四文件 38/38 PASS，类型及差异检查 PASS。

新增 `test-node-session-store.mjs` 接入统一真实临时 PG 整链。测试通过实际 advisory lock 与 `pg_stat_activity/pg_blocking_pids` 证明两个 Store 均阻塞后再放行，不靠概率 sleep；覆盖空/非空原快照、整批新旧集合与权限、其他节点不阻塞、remove/replace 两个顺序、重复 ID 失败保留、INSERT 错误回滚及锁释放。

初次主控 Controller 全量 747/747 与集成 6 checks 通过；随后仅将事务 helper 按职责移入公共模块，冻结后重新验证：`pnpm --dir controller typecheck` PASS、`pnpm --dir controller test` 50 files / 747 tests PASS（00:24:47）、`node verify.mjs --suite integration` 6 checks PASS。后者包含上述真实 PG 竞争、三组件构建、11 项 Compose 检查、原 Go/HTTP/PG 桌面与终端整链、计划/结果/通知/鉴权回归。`git diff --check` PASS；临时 PG 容器与进程由统一入口收尾。精确发布版本及线上错误复核将在实际完成后记录，不将开发通过预记为已部署。

### 正式部署

产品提交 `79b8b34b24f32f6607f8caada169907cd0194949` 已推送，GitHub [38277670501](https://github.com/TaoSama/wechat-super-leader-bot/actions/runs/38277670501) 双平台成功：macOS 单元 1m45s，Ubuntu 全量 6m50s。使用干净 `git archive` 本机构建 linux/amd64；镜像 `super-leader-controller:79b8b34`，OCI revision 短标签 `79b8b34`，image ID `sha256:8af5e04069ebe10d8a7d3e23d8e411d2bd64bdc7d8538e2fbbfc1ad2818cdd1c`。本机与远端精确 ID 和全部 10 层 RootFS 一致。无网络、非 root、只读容器烟测 health/资源/鉴权/登录/Cookie/SSE/退出通过，子 Controller 正常 exit 0。流式传镜像，无落盘备份、无远端构建。

16:36:30 UTC 正常停止原 Gateway 和 Controller，均 exit 0 / OOM=false；PG 未停止。16:36:31 停后全量只读审计无未决命令、claim、待确认计划，五表与停前完全相同。仅执行 Controller 的 `--no-deps --no-build --pull never --force-recreate`。新容器 `f445b05d3e83628bd71a75f0a888cbb29fe12eaefdc496e699e8518a7fc3c4f8` 在 16:36:53 启动，image ID 精确匹配，healthy / restarts=0。16:37:12 五表摘要仍相同，随后恢复原 Gateway。

| 业务表 | 行数 | 停前、停后、启动后审计摘要 |
| --- | ---: | --- |
| commands | 21 | `3d751606f40ad9c773b01d9942d2b701` |
| messages | 35 | `6664c32116ecc134e66298d7ac0fa489` |
| leader_states | 4 | `c76f3101ef9acac290faa1d3e558663e` |
| leader_executions | 1 | `50d9fd2580e6ee3999c0ec9803d8d52f` |
| leader_notifications | 1 | `8b418d890b46446adc71c839da339f0c` |

commands 的运维摘要排除 input_receipt 列；另一个模型重放验收使用全列摘要，二者不能混同比较。

16:38:05 PG 只读核查：节点 A 17 行、节点 B 1 行，各节点所有行的更新时间一致，分别为 16:38:05.715 / 16:38:03.344 UTC，与在线状态接口数量相符。此时新 Controller 日志仅含正常启动，无主键冲突。两节点均 connected，已归档验收会话不在列表。随后把此前成功的 `leader_history_release_20261013_c` 原消息 ID/原文本重新提交：返回原记录及 `16:16:14.664934Z` 的原查询时间；全库命令、计划、通知、聊天 revision/数据和 messages 摘要恒等，脚本 exit 0。原会话保持归档，没有新查询请求或派发。

16:39:42 再查：数量仍为 17 / 1，同批行更新时间持续推进至 16:39:41.060 / 16:39:33.321。启动后约 169 秒的完整 Controller 日志仍仅有正常启动，没有 snapshot upsert、主键或 shutdown 错误；这是短时复核，不是长期稳定性承诺。三服务均 healthy / restarts=0。Gateway 在 16:38:16 曾记一次 `NetworkError`，其后自动恢复；16:39:33 最近轮询成功、consecutive_errors=0、total_error_count=1、processed_message_count=0，通知开关 false。保留临时错误事实，没有重建基线、换 token 或改网络配置。

## 边界与回退

节点级序列化不等于数据库故障时仍可无限积压，也不提供跨 Controller 多权威协调；部署仍保持唯一 Controller。锁不证明微信手机体验、节点 B owner、真实 CLI 或长期负载已验收。

没有 schema 迁移，原记录无需重写；若需要回退应恢复支持现有多技能与计划结果合同的精确上一镜像，并执行同样的排空审计。不能删除缓存以外的业务数据、journal 或 uncertain 状态来绕过问题。
