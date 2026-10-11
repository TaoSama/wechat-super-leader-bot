# 原终端输入投递

## 完整目标与当前阶段

最终需通过微信自然语言及 Web 管理原 CLI 会话、发送任务、获取可信进度和完成证据。此次实现其中的底层原终端投递器，不改变原会话宿主，不以该模块代替完整控制链路。正式 Daemon/Controller 路由、持久去重及完成回查尚未接入，生产仍保持终端只读。

沿用既有显式 socket 和 pane 清单，不解析焦点、不启动或恢复 Agent、不访问 session 字段指向的文件。原 App 通道、原生 turn 回执与固定依赖计划不改动。

## 已核对的宿主边界

安装二进制静态版本 0.9.0，schema protocol 22；未验证运行中 server 的构建哈希。源码核对表明：

- `agent.prompt` 解析一次目标，向同一 PTY runtime 有序写入 text 与 Enter。原 Agent 类型、非 blocked、非 launch-pending 和 foreground 类型在入队前检查。
- `agent_prompted` 只证明输入提交写入结束；返回 AgentInfo 为入队前快照，没有原生 turn ID。
- 入队后的写入及延时 Enter 不绑定 Agent session/PID incarnation。因此预检不能完全封闭 CLI 退出回 shell、同类进程替换或人工输入竞态。没有做真实错投复现，不能声称一定会错投。
- lifecycle `idle/done` 不是本条命令的完成证据。metadata tokens 也没有可读回的已认证报告者身份，不能自动升级为原生任务完成。
- 宿主没有幂等键。任何可能开始提交后的失联、坏回执、目标变化或超时都不得自动重发。

## 底层接口

`DeliveryController` 复用已配置的 `Observer`，只接受该 observer 已发现的完整 `terminal:` ID。构造器不连接、不发送，生产没有调用入口。

`PrepareDelivery(ctx, sessionID, requestID, prompt)`：

1. 校验显式 selector、严格 session ID、UUIDv4 request ID、UTF-8 非空纯文本。prompt 最多 64 KiB，仅允许换行和制表符控制字符；不归一化内容。
2. 在整体 10 秒、单 RPC 3 秒预算内连接既有 socket，首先验证 protocol 22。
3. 新鲜读取目标并核对完整 binding；只接受 idle/done、明确 interactive_ready=true、launch_pending=false、screen_detection_skipped=false。
4. 固定完整目标身份、预检 revision、request ID 和原始投递文本 SHA256。准备阶段绝不发送输入。

`PreparedDelivery.Identity()` 返回值类型的不可变投递身份，供后续 journal 在投递前持久绑定；不能暴露可修改内部状态的指针。

`PreparedDelivery.Dispatch(ctx)`：

1. 每个准备对象仅允许尝试一次，并发调用不产生第二次投递；取消/关闭后不能重新使用。
2. 使用准备时与调用时最早截止；再次核对原绑定、就绪和相同 revision。有已知变更或超期则零输入。
3. 仅调用一次 `agent.prompt`，参数固定为原 pane 与原文本，不附带 lifecycle wait，不切路、不重连重投。
4. 校验关联 response ID、严格 envelope、`agent_prompted`、原目标和非倒退 revision，再读取一次目标复核；不要求仍 idle。
5. 仅在以上证据完整时返回 `terminal-input-written` 类型回执。它不含 turnId、completed 或任务输出，不能解锁依赖。

`Close()` 必须幂等释放连接；处理取消、并发 Dispatch/Close 及关闭失败，不能泄漏自有 socket/goroutine。错误为静态可公开描述，不回传宿主原文、prompt、socket 或 transcript 路径。

## 传输和回执

Observer 的三方法只读白名单不扩大。读写只共享内部编码、截止、严格解码，不提供由外部任意传方法名的 mutating RPC 入口。

请求写入前发生的校验/连接/预检错误，标记未尝试输入。只要可能调用过 prompt 的写入，之后任何失败一律标记 uncertain；不能据错误文案推断未投递。没有底层自动重试。

对象内的一次性防护不等于持久命令幂等。后续接入必须在 Dispatch 前使用现有 journal 领取 command、保存完整目标与文本摘要；重启发现旧 claim 只能核查，不能重新 Prepare/Dispatch。此阶段不得提供 CLI、HTTP、配置开关或生产命令分支绕过该门槛。

## 验证与后续门槛

以本机临时 Unix socket 合成宿主验证真实 JSON RPC。必须覆盖准备零输入、精确中文/多行投递一次、并发重复调用、非就绪/身份变化/revision变化、过期/取消、坏帧/坏响应/丢回执、写入后身份变化、只读白名单不放宽，以及无 completed/turnId。保留原观测与原 Codex 测试。

尚需：持久 claim/回执重放与 ACK、Controller/模型/Web 显式路由、提供方任务关联与完成证据、计划完成策略、真实明确 pane 验收。若拟允许较弱的 Agent 自报驱动后继，需单独向用户说明并取得选择，不能悄悄降低现有完成标准。

生产启用前还需明确接受原终端输入的非原子边界，或获得更强的宿主/提供方接口。不得修改或重启原宿主来绕过该门槛。
