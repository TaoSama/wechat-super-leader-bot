# 原桌面大快照与控制资源边界

日期：2026-10-12。仅修改本地 Daemon 与测试；不更新运行服务，不更改桌面 transport，不重启 App、不新建后端、不恢复或发送真实会话。Controller 仍是唯一编排权威。

## 问题与契约

真实目标的首个快照已经超过 16 MiB。上一轮历史 reader 可接受 32 MiB，但 observer 和控制预检仍只接受 16 MiB，造成同一会话“历史可读，状态/模型不可用”的不一致。原 owner 本身可达，不应通过改 App 连接方式来解决。

- 所有桌面入站共用 `desktopInboundFrameLimit = 32 MiB`；history raw 序列化引用同一常量。超过上限只读 4 字节 header 即拒绝，不分配正文。
- 出站 `desktopOutboundFrameLimit = 16 MiB`，未增加 prompt 或请求上限。
- 控制快照先提取 raw，再用标准 JSON Decoder 流式验证结构，最后展开 typed turns/items。未知字段同样计数；上限复用历史的 250000 个值/容器节点、最大深度 64（root=0）。key 和 closing delimiter 不算独立节点。`UseNumber` 只防止结构扫描误将未知字段合法数字解释为 float64；已知字段仍由原 typed decoder 校验。
- 超限和坏 JSON 返回静态错误，不记录正文。不改变 owner、目标、revision、普通线程、busy/approval、uncertain 或超时预算。
- 每个 `DesktopController` 实例共用两个连接槽；正常 Daemon 只构造一个实例。readiness、PrepareSend/Dispatch 和 InspectTurn 共用池，拿槽后才连接，失败释放；PrepareSend 持有到 Close，Dispatch 不重新取槽。等待支持 context 取消，Close 幂等。
- canonical 展开拒绝同一 entity key 被重复引用，包含跨 island 的重复。不把重复引用视为两个独立表示；原暂态 turns 与 canonical 的独立表示仍按原规则比较。否则节点与帧大小有限也可放大成大量重复序列化工作。

## 没有改变的边界

history 缓存仍最多 4 个目标、消费闲置 60 秒回收，完整加载和分页 context 契约不变；控制池不包含 observer 或这 4 个历史连接，不能称为整个进程最多两个连接。超过 32 MiB 仍明确不可用，不偷偷换来源。

32 MiB 是 wire/raw 上限，不是 Go 堆上限。observer 的精确模型键选择仍临时复制 raw 字段；control 的扫描、raw 和 typed 值也有分配放大。本轮用合成 29 MiB 数据测总分配和独立测试进程 RSS，不能将其当成生产内存上限或压力验收。

私有桌面 IPC 仍依赖已核实的 App 版本；snapshot 无请求 nonce，预检不是原子 compare-and-start；用户同时在原 App 输入的竞态尚未消除。没有利用本轮修复扩大发送权限。

## 证据入口

- `daemon/pkg/codex/desktop_frame_policy_test.go`：入站/出站精确上下界，超大 observer 与 readiness。
- `desktop_control_bounds_test.go` / `desktop_control_concurrency_test.go`：结构预算、三入口共享槽、等待取消和清理。
- `desktop_control_references_test.go`：重复历史引用的工作量放大防护。
- `desktop_readiness_live_test.go`：精确已知 active 目标的真实只读预检，到达 busy 拒绝即通过，绝不 Dispatch。
- `desktop_snapshot_benchmark_test.go`：合成大文本的 observer/control/双 control 分配；不含 transport frame 和 Params 复制。
- 根目录 `test-desktop-route.mjs`：HTTP→PostgreSQL→WebSocket→真实 Go Daemon→模拟 owner，所有 reader 均接收大于 16 MiB 的 snapshot。

结果、失败重试与测量限制见 [VERIFICATION.md](VERIFICATION.md)。
