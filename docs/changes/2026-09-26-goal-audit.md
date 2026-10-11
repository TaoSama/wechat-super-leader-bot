# 原始目标缺口审计（2026-09-26）

## 结论

仓库已经形成一个可测试的本地编排原型：有微信 iLink 适配层、Codex CLI/app-server 路径、跨机节点协议、技能目录、SQLite 记忆、Markdown 降级和较大规模单元测试。但“可本地测试”不等于“原始目标已交付”。截至本审计，真实微信账号、真实微信消息往返、真实模型 turn、两台机器上的 HTTPS/Tailscale 全链路仍没有可复核的运行证据；因此目标状态应标记为“核心代码具备，生产验收未完成”。

本次只读检查对象是 `wechat-super-leader-bot/`；没有修改源代码，没有发送微信消息，没有启动常驻服务，也没有提交 Git。

## 证据分级

| 领域 | 当前已有证据 | 仍缺的证据 | 判定 |
| --- | --- | --- | --- |
| 微信真实接入 | `ILinkWeChatTransport` 实现二维码登录、`getupdates` 长轮询、上下文 token 回复和 `sendmessage`（`src/super_leader/wechat.py:150-169`；`docs/runbook/index.md:3,27`）；测试使用 fake transport/占位 URL（`tests/test_core.py:84-152`） | 真实扫码、凭据落盘、真实收发、重启续轮询、平台错误/限流/配额 | 阻断级缺口 |
| Codex App/CLI | app-server 支持 Unix WebSocket daemon，失败回退 stdio；CLI session 发现/执行路径存在（`src/super_leader/codex_app_server.py:32-73`；`docs/runbook/index.md:29`） | 未验证真实 `/turn`/模型写入链路；现有真实 daemon 证据只覆盖 initialize/thread-list，已有变更文档明确未发送 turn | 高风险未验收 |
| 跨机 | 节点注册、心跳、任务队列、结果回传、spool outbox 和 HTTPS 校验代码/测试存在（`docs/runbook/index.md:51-81`） | 两台实际主机、真实证书/域名、Tailscale 或受控 HTTPS、节点执行和结果回传的端到端日志 | 阻断级缺口 |
| 技能 | `SkillRouter` 从多个根目录发现并做白名单/短名解析（`src/super_leader/skills.py:1-72`）；`/skills`、`/skill` 文档和测试存在（`docs/runbook/index.md:45-47`） | 未证明目标机器的技能根目录一致、技能内容可被远端任务安全加载、真实技能执行结果可回传 | 中高风险缺口 |
| 记忆 | SQLite `MemoryStore`、聊天/长期记忆/路由绑定/回执去重均有实现和测试（`src/super_leader/app.py:35-60,464-495`；`tests/test_memory_store.py`） | 未验证多进程并发、数据库损坏恢复、备份/迁移、跨机共享边界；既有记录也承认仅覆盖本机单进程 | 中风险缺口 |
| Markdown | 有微信轻量转换、代码块/链接保留及长度截断（`src/super_leader/wechat.py:30-76`），测试覆盖基础降级和截断 | 未验证真实微信客户端渲染、复杂表格/嵌套 Markdown、分页跨页排版；文档明确不保证跨页完整 | 中风险缺口 |
| 测试计划 | `docs/TEST_PLAN.md` 已列出离线门槛、扫码、Task、跨机验收步骤（第 1-5 节）；本次实测 `.venv/bin/python -m pytest -q`：582 passed in 4.85s | 未执行该计划中的扫码、真实 Task turn、两机节点、真实微信命令序列；缺少可保存的现场日志/截图/时间戳和失败重试证据 | 计划有，执行证据缺 |

## 逐项审计

### 1. 微信真实接入

实现层面不是纯 mock：`--wechat-login`、`--wechat-poll-once`、`--wechat-daemon` 入口存在，iLink transport 会持久化账号和状态，凭据默认路径及 `0600` 约束在运行手册中说明（`src/super_leader/__main__.py:16-24,69`；`docs/runbook/index.md:20-27`）。

但是测试没有连接微信服务。`tests/test_core.py` 通过继承 transport 的 fake 请求或 `https://example.invalid` 验证协议形状，不能证明二维码可扫码、服务端字段与当前平台一致、真实消息能到达或回复能被接收。README 的“可以……在线接入”是能力声明，不是现场验收证据（`README.md:32`）。

下一步：在隔离账号上执行 `--wechat-login` → 手机确认 → `--wechat-daemon`，保存 QR/登录时间、进程日志、消息 ID、回复原文和重启后的续轮询结果；再按 `docs/TEST_PLAN.md:24-33` 完成 `/help`、`/remember`、`/recall`、`/threads`。任何失败都应记录 HTTP 状态、响应摘要和是否重试，禁止把 token 写入报告。

### 2. Codex App/CLI

代码同时覆盖三条本地观测面：rollout/session 目录、独立 `codex app-server --stdio`、本机 app-server Unix WebSocket；app-server 初始化失败会回退（`src/super_leader/codex_app_server.py:59-73`）。`/thread` 读取摘要，普通文本和 `/turn` 可路由到 app-server（`src/super_leader/app.py:124-162,500-577`）。

边界是：测试大量替换 `desktop.send_turn`/`read_thread`，只验证编排契约；已有真实 daemon smoke 的历史记录只证明 initialize 和 thread-list，且明确未发送 turn、未修改 Task、未发微信、未测跨机。因而不能宣称“真实 Codex 任务已经被微信控制”。

下一步：先在无破坏性 Task 上执行 `docs/TEST_PLAN.md:35-40` 的 `请只回复 READY，不修改文件`，记录桌面端可见 turn、app-server 原始响应和微信回复；然后分别断开 daemon 验证 stdio 回退，并验证异常时不会重复 turn。

### 3. 跨机

控制面和节点协议已有明确安全边界：节点默认强制 HTTPS，控制面本身是明文 HTTP，需外置 TLS 代理；节点任务有 queued/running/completed/failed、领取、心跳、结果确认和 outbox（`docs/TEST_PLAN.md:41-85`；`docs/runbook/index.md:63-81`）。这证明设计意图和本地协议测试，不证明网络拓扑真实可用。

尤其不能把 `127.0.0.1`、占位域名或“仅有 Tailscale 连通”当作完成。需要两台真实主机和真实证书，且跨进程微信 daemon 与控制面必须使用同一个绝对数据目录；节点不共享该目录（`docs/TEST_PLAN.md:64-74`）。

下一步：先部署同机 TLS 反代并以 `curl --fail --show-error` 验证，再从第二台机器注册节点、心跳、拉取只读任务、回传结果；最后制造网络断开/429/重启，核对 outbox 补报和 uncertain 状态，保存两端日志及任务 ID。

### 4. 技能、记忆与 Markdown

技能发现范围包括 `SKILL_ROOTS`、`~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills` 和 dotfiles；短名只有唯一物理路径时才生成，白名单按调用名精确匹配（`docs/runbook/index.md:45-47`）。缺口是部署环境差异和技能执行的真实回传链路，尤其是远端节点不能假定拥有控制面机器的本地技能文件。

记忆在本机 SQLite 中持久化聊天记录、长期笔记、路由绑定和消息回执；`SuperLeader.close()` 会关闭三个存储/传输对象（`src/super_leader/app.py:41-60`）。现有测试足以支持本地函数语义，但不能支持共享文件、多进程写竞争、损坏恢复或迁移承诺。应先明确“记忆只属于控制面”还是“节点也可写入”，再做锁、备份和恢复验收。

Markdown 转换是故意的轻量降级：标题、列表、强调、链接和代码块处理后发送纯文本，超过 4000 字符截断并追加提示（`src/super_leader/wechat.py:17-76`）。这适合最小可用回复，但复杂 Markdown、分页边界和真实客户端排版仍是待测项，不应按完整 Markdown 渲染器宣传。

## 建议的最小验收顺序

1. 保存当前离线基线：`compileall`、全量 pytest、`--check`，并记录版本（Python、Codex CLI、项目 commit）。
2. 完成真实微信扫码与四条基础命令，确认凭据权限、去重、重启续轮询。
3. 完成本机真实 Codex app-server 的只读 READY turn，再验证 CLI stdio 回退。
4. 用两台主机和真实 HTTPS/Tailscale 完成节点注册、只读任务和结果回传；追加断网/重启恢复。
5. 执行一次真实 `/skill` 和 `/remember`/`/recall`，确认技能来源、记忆归属和消息格式；保存证据后再决定是否扩大权限或开放公网入口。

## 证据边界

- 缺失数据源：真实微信账号/服务端响应、真实 Codex 模型 turn、第二台可用主机、TLS 证书和 Tailscale 拓扑；因此无法判断平台兼容性、端到端延迟、跨机可靠性和生产可用性。
- 推定而非实测：实现可调用 iLink、app-server 和节点 HTTP 的结论来自源码与替身测试，不是外部服务成功调用；README/runbook 的“可用”表述均按能力声明处理。
- 精度限制：本次 pytest 时间 `4.85s` 是单机单次观测，不是性能基准；测试中的合成消息、替身响应和本机回环不能外推真实网络/模型延迟。
- 采集通道与交叉验证：源码、测试、runbook/变更记录相互核对；没有第二条外部运行通道。真实微信、真实模型和跨机部分因此保持“待验证”，不标记完成。
