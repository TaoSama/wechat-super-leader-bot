# 原会话轮次追踪

## 契约

Controller 是命令与 turn 关联的持久化权威。Daemon 仍只连接宿主机既有 Codex socket，不创建 app-server、worker 或 resume 会话。

1. 用户确认后，Controller 仅派发一次 `command(action=send)`。
2. Daemon 从 `turn/start` 响应中取出精确 `turnId`，返回 `result(status=accepted, turnId)`；accepted 不代表完成。
3. Controller 保存 turnId 后回复 `result_ack`。Daemon 未收到匹配 commandId、turnId、status 的 ack 时，在后续连接/心跳重传结果，不重发 prompt。
4. Controller 基于已保存的关联发送只读 `inspect_turn(commandId,nodeId,sessionId,turnId)`。Daemon 读取 `thread/read(includeTurns=true)`，只认该轮次，不能以会话 idle 或最后一轮状态替代。
5. `inProgress` 映射 accepted；`completed` 映射 completed；`failed` / `interrupted` 映射 failed。查不到、未知状态或读取失败映射 uncertain，并允许后续只读复查。

`expiresAt` 是允许派发的截止时间，不是 Agent 执行时限。已取得 turnId 的任务不能仅因超过派发 TTL 判定执行结束。

## 恢复边界

- Controller / Daemon 重启或网络恢复后，从数据库中的 turnId 继续查询，不重新执行 send。
- 生产 Daemon 使用 bbolt 本地日志，调用适配器前同步写入 claim；已有 claim 永不授权再次执行。重启发现未完成 claim 时只恢复 uncertain，不调用适配器。
- 启动响应持久化后，未 ACK 回执可跨进程重传；ACK 必须匹配 commandId/status/turnId。确认后清除本地正文与错误内容，但保留防重记录及 turn/status；完整审计由 Controller 保存。
- **turn 已启动、响应尚未持久化到 Daemon 时若崩溃，仍可能失去 turnId。** 此时只能保留 uncertain 并人工核验，不能宣称 exactly-once、硬件掉电无损或自动恢复执行。
- 查询结果只能证明对应轮次的生命周期状态，不能证明业务要求全部达成；代码测试、产物和用户验收仍需另行验证。
- 未加载、被删除或不可读取的原会话不会被后台 resume 来伪造恢复。
- 不自动处理原会话的审批请求，不扩大原会话权限，不主动发送微信通知。

## Web

命令详情展示关联 turnId，并将 expiresAt 标为“派发截止（非执行时限）”。accepted 与 completed 继续明确区分。只读 Web 不提供隐式执行入口。

## 本地日志运维

- `--state-dir` / `DAEMON_STATE_DIR` 必须为绝对路径。独立启动默认 `~/.super-leader/daemon/<nodeId 的 SHA256 前16位>`；本项目启动器指定 `.runtime/daemon-state`。
- 目录 0700、`commands.db` 0600，拒绝最终路径软链和宽松权限；数据库独占锁禁止两个 Daemon 共用。日志绑定 nodeId、Controller URL、Codex socket；token 轮换不改变绑定。
- 指纹只保存完整命令的 SHA256，不保存 prompt 明文。回执正文最多 16 KiB，错误最多 1024 字节，按 UTF-8 边界截断。
- 未 ACK 上限 2048 条，记录上限 100 万条，数据库上限 512 MiB，单条上限 128 KiB；满或损坏时拒绝新派发，不驱逐旧防重记录。已有零字节文件或缺失 schema/scope 时拒绝启动。
- 不删除日志来“修复”未知状态；人工删除会丢失该节点防重依据。迁移或回滚须保留日志并使用支持同一 schema 的版本，不能退回内存版继续派发。当前不自动备份、清理或迁移日志。
