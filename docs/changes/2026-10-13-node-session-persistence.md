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

## 边界与回退

节点级序列化不等于数据库故障时仍可无限积压，也不提供跨 Controller 多权威协调；部署仍保持唯一 Controller。锁不证明微信手机体验、节点 B owner、真实 CLI 或长期负载已验收。

没有 schema 迁移，原记录无需重写；若需要回退应恢复支持现有多技能与计划结果合同的精确上一镜像，并执行同样的排空审计。不能删除缓存以外的业务数据、journal 或 uncertain 状态来绕过问题。
