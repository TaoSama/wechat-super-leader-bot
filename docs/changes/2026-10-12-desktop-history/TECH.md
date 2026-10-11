# 原桌面历史读取

后续 2026-10-12 修复统一了所有桌面入站的 32 MiB 上限。本文保留下述历史初版的 16/32 MiB 差异作为演进记录，当前资源契约见 [大快照边界](../2026-10-12-desktop-frame-budget/TECH.md)。

## 目标与边界

使 Web 能读取用户正在原桌面应用中查看的会话历史，并连续向上翻页和更新最新消息。Controller 仍是唯一编排权威；Daemon 只订阅原 owner，不另启后端、不恢复线程、不更改 App transport、不获取 writer。完整加载可能填充 owner 缓存，外部取消不代表取消 owner 内部工作。本轮不部署或发送真实会话。

## 跨层契约

1. `SessionHistory` 必须增加 `historyContext`（不透明 UUID）及 `source`（`control-socket` 或 `codex-desktop`）。首次请求没有 context；后续最新轮询及分页都携带同一 context。用户“重新读取最新页”才显式开始新 context。请求 cursor 必须带 context。无旧格式兼容分支。
2. Daemon 内存 registry 将 context 固定到 node/session/source 和桌面 cache generation。原生 cursor 与桌面稳定锚点均包装为不透明 UUID，并绑定 context；不直接接受底层 cursor。context 最多 128 个、10 分钟未使用到期；每 context 最多 256 个不同 cursor，同一底层 cursor 复用 token。失效不自动换 reader。
3. 无 context 的初次来源选择：存在目标已确认的桌面 owner（合法非空 OwnerID）观测记录且配置桌面接口时使用桌面；初始无 owner 的 unavailable 占位不构成证明，应使用控制接口。已确认 owner 的失联记录仍保留该来源。已有 context 不受后续库存变更影响，不能退回另一接口。
4. 统一静态错误：`History context expired` → 409/`history_context_expired`；`History incomplete` → 502/`history_incomplete`；`History response too large` → 413/`history_too_large`。已有 unavailable/busy/timeout 保持静态错误，不透传 IPC 内容。Web 遇 context 失效保留已读内容，停止旧 context 的自动轮询/分页，显示显式重新读取入口。
5. 新 `cancel_history` 信封仅含 type/requestId/nodeId/sessionId。Controller 取消或超时先移除 pending，再向仍 OPEN 的原连接发送取消。Daemon 按精确三元组取消注册的 waiter，不取消其他请求共享的已建立缓存；重复/错目标/迟到取消无副作用。Web 20s、Controller 15s、Daemon 8s 的请求预算暂不更改。

## 宿主读取器

- 对精确会话发现 owner、只读 settings 验证普通 resumed 线程，订阅同 owner 的 version 11 stream。不要求 idle 或发送用的 threadStartKind，读取不能借用发送资格。请求显式携带方法版本；真实 response 不含 version，响应以 requestId/method/owner 绑定，不要求虚构的 response.version。
- 每个连接只有一个 reader，同时处理响应及 snapshot/patch。禁止使用会丢弃广播的同步 `receiveResponse` 等待 load-complete 响应。
- 首个快照不完整时，每 cache generation 最多请求一次 `thread-follower-load-complete-history` version 1；响应仅为 revision。必须已应用同 owner revision >= 响应 revision，并重新验证完整性后才能返回分页。不能把部分历史当成完整，也不把 incomplete 塞入表示正文裁剪的 truncated。
- 采用 owner 完整历史 `Eo` 语义：canonical 按 islands/entries→entitiesByKey 展开，要求 isComplete=true、恰好一个 island、每个 turn 的 itemsPagination.hasLoadedOldest 不为 false；旧形态要求 resumed 且 turnsPagination.hasLoadedOldest 不为 false。完整性字段缺失时的默认语义遵循已核实的客户端，坏类型不放行。独立 projector 复用公开条目的白名单转换。未知形态、缺实体、重复/不合法真实身份等 fail closed；不复用仅用于精确 turn 回执的 recordedTurns。
- 不复制 UI 的 `J/Ln/Rn` 暂态合并算法：已记录完整历史与未合入的 UI 草稿/局部暂态是不同来源，不将两者混称为完整导出。权威 turns 内 accepted steering 仅在有合法真实 serverUserMessageId 时转换为公开 userMessage，已有 native userMessage 优先，不输出 pending、steered marker 或私有 reconciliation 字段。真实逐 item 时间缺失则省略，不伪造 turn 时间。
- 持续订阅服务于当前历史 context 的两秒快照读取，不每两秒调用完整加载。最多 4 个目标，历史专用 frame/raw 序列化上限 32 MiB；observer/send 仍为 16 MiB。超限先检查四字节 header，不分配正文。另限 4096 patches、64 层、250000 节点、32768 items、16384 turns、累计 256 MiB patch 工作量；这些不是 Go 堆内存的上限。满额拒绝新目标，不驱逐正被请求的目标。
- 持续 observer 在精确 discovery 成功后先发布 owner 证明（unknown/unavailable，不含模型、观测时间或 revision），之后才尝试快照。因此超过 observer 帧上限的目标仍可进入独立历史 reader。冷启动占位不能吞掉该证明；same owner 的失联保留旧投影及原时间，owner 更换时清空旧投影，均不授予发送权限。一次性 Snapshot 接口仍只发布实际快照。
- 闲置 60 秒（按请求消费时间，不按后台 patch）退订并清理；连接出错、owner/generation 变化、revision gap 或重排破坏连续性时失效旧 context。普通追加和正文更新不换 generation。Daemon/Controller 连接退出清理所有历史缓存；不得影响命令执行或 journal。
- 桌面分页使用稳定 `(turnId,itemId)` 锚点及此前身份顺序证明，不使用裸数组下标。锚点丢失/前缀重排必须 context expired，不能跳过或重复一段后声称连续。

## 分工和验证

- Daemon 协作任务：仅 `daemon/pkg/codex/desktop_history*` 及必要 Go module 依赖，负责协议、投影、缓存和 tests；不得改发送逻辑。
- Controller/Web 协作任务：仅 `controller/`、`web/`，负责新字段、cancel、错误与 context 生命周期测试；不得改认证或发送边界。
- 主任务：Go protocol/client 路由与取消、跨层 fixture、文档和独立验收。所有改动先读文件，保留原脏树，不创建备份。
- 验证必须覆盖混序响应/patch、完整性假阳性、canonical 合并、过滤私有内容、来源/目标/世代绑定、并发与取消、TTL回收、游标重排、错误响应、向上滚动及最新页固定 context。真实读取仅使用精确目标，不更改用户模型或发送消息。
