# 遗留工作区内容审计（2026-10-31）

## 结论与边界

本报告固定对照主干提交 `923d102275a215b06df2f54c481e6674bb999f8b`（`fix(wechat): restore low-budget renewal reminder threshold (#74)`）。主仓库路径以 `<repo-root>` 表示（在仓库根目录执行 `git rev-parse --show-toplevel` 获取）；除特别标注，旧目录位于其 `.claude/worktrees/`。所有旧目录只读；本轮遗留审计只新增此报告，没有移植补丁、解决旧冲突、清理旧目录、启动业务或部署。

已经确认确有**未提交且未被当前主干等价吸收的修复内容**，主要集中在 `fix-audit-regressions-20261023`。但文件数量、旧分支提交数量都不能直接解释为“漏了多少功能”：许多旧 dirty 文件已与当前主干逐字相同，另一些已拆分或被后续实现替代。下文按用户可见行为分组，区别“已吸收”“部分吸收”“未见等价实现”“待确认”。

本报告完整盘点所列目录的未提交状态、逐文件内容对应关系，并核对关键分支尾部补丁；**不是对所有旧历史提交的逐补丁全面审计**，也不是运行验证。不能据此宣称整个项目只遗漏这些修复。尤其 rem59/61/62/69 与当前主干找不到共同 ancestor，旧历史差异不能自动解释为未合入；稳定 patch-id 无匹配也不能排除 squash、改写或重组吸收。

用户已再次确认：微信业务保留 **23 小时窗口、22 小时时提醒、10 条额度**；本报告不改这些规则。当前提醒问题的全局额度/context token 修复由主任务单独处理。

## 此前做过什么、还留下什么

此前操作记录中，批量删除了 120 个本地分支，随后又删除 PR #72 对应分支，合计至少 121 个；实际移除过 8 个 worktree 目录，之后又移除旧 ad68 目录，合计 9 个。另有一次失效 worktree 登记的 prune，以及对应临时快照清理；登记清理不等于又删了一个实际目录。这些是此前记录，本轮审计没有新增删除。

本轮按旧 HEAD、未提交工作文件和固定主干三方比较，确认内容是否存在；没有把合并标记或提交数量当作功能已经合入的证明。自动部署链修复已由 PR #73 合入，23/22 小时及低额提醒规则由 PR #74 合入；本次全局额度修复单独提交。旧修复包没有整包搬到主干。

2026-10-31 本次再次读取 `git worktree list --porcelain` 时，主库登记有 11 个工作区（含主目录与本次新工作区）。除下表展开的目录，还保留了：

- `remediation-55`：干净的 PG fixture 分支，PR #58 仍开放，四个 PostgreSQL 测试文件未随本次发布迁移。
- `reliable-auto-deploy`：PR #73 的干净开发副本；生产发布逻辑已合入。
- `global-wechat-reply-budget`：本次额度修复与审计报告工作区。

旧 settings 的未完成 cherry-pick/冲突、fix-audit 的未提交修复、主目录的未提交 README、PG 诊断脚本和依赖软链接均留在原位置。它们分别是未收尾的集成现场、待迁移源码、文档改写及本地验证辅助，不能统一说成已上线功能。不要据此把整个旧目录删除。

## 工作区状态总表

| 目录 | HEAD / 状态 | 内容结论 |
|---|---|---|
| 主仓库，分支 `codex/wechat-settings-latest` | `bdca819`；3 tracked dirty | 两个 rollout 文件与主干完全相同；README 是另一套未提交改写，不能全盘覆盖当前文档 |
| `fix-audit-regressions-20261023` | `cece7eb`；51 tracked dirty、10 新源码/测试、250 编译输出 | 有真实遗留修复；按 F1–F11 逐项核对 |
| `publish-remediation-main` | `1a1a9e0`；15 tracked dirty | 11 文件与主干完全相同；其余 4 项主要已吸收并被主干扩展 |
| `wechat-settings-on-head` | `10d3b98`；74 tracked 状态项，30 冲突 | 未完成 cherry-pick；设置整块已存在主干，不能视为“74 个功能漏合” |
| `remediation-59` | `a387b19`；仅 node_modules 软链接未跟踪 | 尾部 opaque node ID、历史读取权限与 scroll 性能改进可在主干定位 |
| `remediation-61` | `8136367`；诊断 hook、node_modules 软链接未跟踪 | direct steer 撤权/恢复关键内容可在主干定位；hook 是诊断辅助 |
| `remediation-62` | `9736453`；3 PG 验证脚本、node_modules 软链接未跟踪 | 尾部 renderer API 清理已吸收；脚本是诊断/验证入口 |
| `remediation-69` | `1548353`；2 tracked dirty | queue 实现已吸收；额外 FIFO blocker 回归测试未吸收 |
| `source-available-release` | `0128939`；独立 .git，干净 | LICENSE、NOTICE、4 个 package 文件与主干完全相同；README 后续有改写 |
| 外部 `792d/wechat-super-leader-bot` | `a1e12ce`；干净 | #57 内容确认已入主干；本地 checkout 比最终集成少后续两个提交 |

以上状态为读取时快照，父任务仍在新的业务工作区继续修复。

## 主目录未提交改动

### rollout 解析修复：已吸收

`daemon/pkg/automation/rollout.go`、`rollout_test.go` 的**工作文件 bytes 与固定主干完全相同**。遗留意图包括：

- 心跳只严格解析 automation_id/current_time_iso，instructions 正文不要求 XML 转义，允许正文出现小于号和 &。
- 坏 JSON 行只影响相关 scheduled turn 的证据范围，不能让无关历史坏行抹掉准确完成证据。
- 支持 AgentMessage content 的对象 text 格式。
- 测试覆盖 malformed heartbeat、turn 内/外坏行、对象正文。

因此这两份 dirty 不属于当前遗漏。

### README 精简：未整包采用，需文档事实核对

工作文件将原长 README 改写为约 130 行，重新描述架构、开发与许可；与主干现有 README 不同。它包含“业务记忆只在 Controller PG、Gateway 无独立业务记忆”等架构陈述，而当前主干仍有 Gateway workspace/记忆资源接口。应按实际运行架构重新编辑，不能把旧 README 当作可直接恢复的正确版本。本报告没有对每个文档陈述作事实验收。

## fix-audit-regressions-20261023：按行为核对

### F1 后台任务到汇报截止时给确定性的部分报告：未见等价吸收

**原意**：即使模型仍在运行、来源结果不齐，到 deadline 也根据已持久证据发送“已有结果及缺项”；初始模型不能在 deadline 后再启动。迟到可靠结果单独补充，不能覆盖已发截止报告或重复交付。截止报告本身有 24 小时投递 TTL；撤权/取消后不再新启动或汇报。

旧改动涉及 automations/contracts/state、background/contracts/service，新文件 `controller/src/background/deadline.ts` 和 `background-deadline.test.ts`；关键字段为 `deadlineReportedAt`、`report: "background_deadline"`。

**主干证据**：

- automations/contracts.ts、automations/state.ts、background/contracts.ts 仍与旧目录未修改前 HEAD 完全相同。
- 主干没有 deadline.ts、background-deadline.test.ts，也无 deadlineReportedAt/background_deadline 符号。
- `controller/src/background/service.ts:262` 在未到 deadline 时等待来源；到 deadline 后第 268 行仍启动 initial 模型调用。
- 第 282、289、299 行 launch 边界是 expiresAt，而不是 initial 的 min(deadlineAt, expiresAt)。
- 第 327 行已有“模型返回 waiting 且过 deadline 时给结束摘要”的逻辑；这是依赖模型回执的汇报，不等于旧补丁的确定性截止报告。

**后续所需**：独立迁移并验证“deadline 时模型挂起”“deadline 后迟到结果”“撤权/取消”“过执行窗仍可投递截止报告”。不能把现有 waiting 摘要当作完整替代。

### F2 只取消这一轮后台任务，不取消未来定时计划：工具入口未吸收

**原意**：新增 `cancel_background_task(runId)` 与 `backgroundOperations.cancel` 授权，取消当前 run 及追问；与 `update_automation(status=cancelled)` 取消未来计划分离。

旧改动涉及 leader/background-tools、direct-contracts、direct-executor、orchestrator、model/background-authorization、user-authorization，以及 Gateway direct-tools 和对应测试。

**主干证据**：background-tools.ts、direct-contracts.ts、Gateway direct-tools.ts 仍等于旧未修改基线；全主干未发现 cancel_background_task。主干已有 background service cancel 及 HTTP router 能力，故不能说“完全不能取消后台任务”，缺口是此次设计的模型工具与授权入口。

**后续所需**：以当前 API/授权模型接入取消本轮入口，验证取消本轮后下次 cron 继续执行，以及不会意外撤销未来 schedule。

### F3 discovery、幂等日志及预览确认顺序：未吸收

**原意**：

- 真正开始新 mutation 前先检查当轮发现的 run/source；失效 discovery 不先占用 journal，从而允许重新发现后重试。
- 已完成回执重放不重新要求 discovery，也不重复执行。
- 普通只读查询不消耗“预览后的自然语言确认”机会；真正另一条 mutation 才更新 followupMessageId。

**主干证据**：

- direct-journal.ts 仍与旧未修改基线相同，无旧补丁 beforeStart 钩子。
- `controller/src/leader/direct-executor.ts:167` 在 context() 收到新消息时就设置 preview.followupMessageId。
- 同文件第 305 行仍以 followupMessageId 等于当前 messageId 判定确认。

**后续所需**：逐层核对当前 journal 重放/claim/发现校验顺序，迁移相应测试。避免只移动某个 if，破坏已有幂等回执。

### F4 规则模式 active/idle 会话目录过滤：未吸收

**原意**：resolver 与 HTTP 规则入口复用 `parseSessionDirectoryQuery`，识别 active/idle，过滤结果为空时不回退全列表。

**主干证据**：

- 主干 packages/wechat-text 已有 parser 声明，但 resolver.ts 没有使用它，NLIntent 也无 status 属性。
- resolver.ts:70–77 仍只把列表指令解析为 list_sessions。
- server.ts:432–437 对 list_sessions 仍将全量 sessions 交给 renderSessionDirectory。
- 旧新增 rules-session-directory.test.ts 不存在于主干。

**后续所需**：复用现有 parser 接入规则路径，验证 active/idle/空结果及普通列表，不另造 parser。

### F5 WebSocket 命令有界发送、历史读取权限、inspection 释放：已重构吸收

**原意**：命令写入设超时、容量与 buffer 限额；检查广告的历史读取权限；没有 turnId 的 inspection 也能被最终回执释放。

**主干证据**：

- `controller/src/nodes/command-transport.ts:4` 定义 5000ms 写超时，第 19 行使用命令剩余 TTL；还有 pending 64、1MiB buffered 限额与失效 transport 处理。
- `controller/src/nodes/hub.ts:156` 拒绝没有 read 能力的历史请求。
- hub.ts:400 接受 inspection.turnId 为 undefined 或等于消息 turnId。
- 主干有 command-transport.test.ts 等替代测试，不能因旧 command-write-lifecycle.test.ts 同名文件不存在就判实现缺失。

**后续所需**：若迁移旧测试，先核对替代测试覆盖；无需恢复 hub 内旧 inline 发送实现。

### F6 模型进度通知公平性、停止顺序与证据原子性：未吸收

**原意**：

- 并发 4 个模型进度生成时，后续计划/目标等待可用 slot，而非该页后半部分一直跳过。
- stop 先 abort 活跃调用再等待扫描结束，避免扫描等待 slot 造成停止死锁。
- PG 对来源 commands 按稳定顺序持有 FOR SHARE 到 COMMIT；缺来源 command 不发布 draft。
- MemoryStore 在异步读取后、发布前同步检查命令快照/eventKey，防 accepted 已变 completed 仍发旧进度。

**主干证据**：

- notification-progress-postgres.ts 与旧未修改基线完全相同。
- `controller/src/notifications/model-progress.ts:94` 仍先 await scanning，未出现旧补丁等待 slot 循环。
- `controller/src/store/memory.ts:505–510` 异步取 commands 后只复查计划/目标 revision/status，没有同步重取并比对来源 command 证据。
- 旧 model-progress-fairness.test.ts 不存在主干。

**后续所需**：同时迁移公平调度与停止顺序，PG/Memory 原子性分别验证；仅调高并发不能解决根因。

### F7 Desktop 历史 cursor 容量淘汰：未吸收

**原意**：cursor 达容量时逐出最少使用 token；过期 token 明确 context expired，不能重新绑定到别的 anchor，也不应因容量满让整轮历史读取报错。

**主干证据**：`daemon/pkg/codex/desktop/history.go` 和 history_stream.go 仍与旧未修改前相同；新增 history_cursors.go、history_cursor_retention_test.go 均不存在于主干。此处是 desktop source cursor，不能与其他 daemon client cursor 修复混同。

**后续所需**：独立迁移并运行容量、LRU 使用顺序、过期 token 不重绑测试。

### F8 Controller 到 Gateway 大回复流：未吸收

**原意**：允许 Controller 合法 8MiB 结果，按 JSON 最坏 6 倍转义预留有界 final frame，progress 仍使用小限额；以字节帧跨 chunk 安全解码 UTF-8，避免不断复制增长字符串。

**主干证据**：gateway/src/controller/message-stream.ts 与旧未修改前完全相同；第 12 行 MAX_FRAME_BYTES 仍 256KiB，第 13 行 MAX_STREAM_BYTES 仍 1MiB。旧实现及测试未吸收。

**后续所需**：结合当前 Controller 响应合同确认实际最大值，验证大 final、小 progress、总预算和跨 chunk UTF-8，而非简单去掉限制。

### F9 入站逐条验证、坏消息隔离、无效时间不续期：部分吸收

**原意**：chatId 64、messageId 128、text 16000 与 Controller 合同对齐；单个坏消息记录 trace 后跳过，不阻塞同批后续消息；旧 durable inbox 非法项退休不重跑；持久化失败不能被当作输入错误吞掉；无效平台时间不能刷新额度。

**主干证据**：

- 未发现旧补丁 normalizeInboundMessage/InboundValidationError；新增 inbound-validation.test.ts 不存在。
- 无效 created_time 省略 undefined 的修复已通过 publish 分支后续吸收，见下节；因此“坏时间戳处理全部漏了”不成立。
- 不能把当前主任务正在实现的全局额度修复视为此旧补丁整体已迁移。

**后续所需**：按当前 inbox 结构迁移逐条边界验证和错误隔离；单独回归“同批坏项后仍处理好项”“IO 失败保留重试”。

### F10 原生线程身份、未提交 supplement 回执与读取新鲜度：部分吸收

1. **线程身份已吸收**：main app-server.ts:311 接受 onThreadStarted；334 行在 turn/start 前 await 回调持久 threadId。不能把整个 app-server dirty 判为遗漏。
2. **未提交 supplement 回执未吸收**：旧补丁用 UNSUBMITTED_SUPPLEMENT_REPLY/hasUnsubmittedRequests，保留原完成回执，但未提交补充仍 stage=started，不能谎报 completed。主干无这些符号；codex.ts:479–480 的失败分支只基于 consoleCallDispatched 决定 started/failed；527 行正常结果仍直接 stage=completed。当前是否还有其他边界保护需执行对应失败场景验证。
3. **console 回执限制有差异**：主干 workspace.ts:122 仍强制 controller-console provenance 只能 stage=completed；旧允许经过校验的 console segment 存于未完成回执。不可只改单边 schema。
4. **读后写后再读已有替代**：control-mcp.ts:59 使用 readGeneration，216 行纳入只读调用 key，260 行 mutation 结束后递增。旧每次只读调用使用新 UUID，语义更宽；无 mutation 的同参重复读取目前仍可能复用旧响应，是否需要实时重新发现应单独确认。

**后续所需**：迁移 supplement 失败测试并核对 journal/schema/console 三端；读取新鲜度按实际业务语义决策，不能把 randomUUID 生搬入现有幂等设计。

### F11 Web 历史阅读位置与跟尾连续性：部分吸收

**已存在的替代**：主干 useHistoryScroll.ts 已有 hasOlder、paginationChanged、viewport resize、geometry 性能优化。

**仍有差异**：

- 旧补丁在隐藏后重新打开时以 resume.bottom 恢复 readingIntent；主干 230–234 行重开时仍先设 bottom=true、readingIntent=false，没有旧恢复逻辑。
- 旧补丁在 itemsChanged 引起工具状态展开/布局变化时也跟尾；主干第 274 行触发条件仍是 reopened/viewportResized/paginationChanged/signature/insertedItems，未覆盖旧补丁所有组合状态变化。
- 新 history-state-continuity.test.tsx 不存在主干。

**后续所需**：基于现有优化保留 viewport/阅读意图状态，跑“历史中部隐藏重开”“尾部工具状态变化”场景。不能覆盖整个旧 hook。

## publish-remediation-main：发布工作区遗留与主干关系

15 个 tracked dirty 中，11 个工作文件与固定主干 bytes 完全相同，详见附录。剩余 4 项已逐 diff 核对：

| 文件 | 旧意图 | 主干现状 |
|---|---|---|
| controller/src/commands/service.ts | failAdmittingCommand 防止失败覆盖已转态命令；queue 每轮从头重扫，避免动态 FIFO blocker 解除后被 cursor 跳过 | 两点均在主干；主干保留按 node 并发，旧工作副本将全部 node 串行，不应移植回去 |
| controller/src/deliveries/memory.ts | MemoryDeliveryRepository 注入 now，避免恢复/测试混用 Date.now | 主干已有同样注入，另有 hasActiveDelivery |
| controller/src/runtime/task-notifications.ts | 实例化 MemoryDeliveryRepository(now) | 已吸收，主干另有 settings 注入与 hasActiveDelivery |
| gateway/src/wechat/client.ts | 非法平台 created_time 返回 undefined，不能输出 NaN 续期 | 已吸收；主干另有旧 citation/verbatim checkpoint 兼容和 renewalReminder 计划版本修复 |

结论：此目录不是“15 项代码漏合”。旧文件覆盖主干反而会丢掉后续改进。

## wechat-settings-on-head：未完成集成副本，设置功能主体已吸收

此目录 CHERRY_PICK_HEAD 为 `6a5153771fdf13e4678b49ddb845b4a83ba2e297`，74 个 tracked 状态项、30 个冲突，不能作为可运行分支或整包恢复源。

**原意**包括 Controller/Gateway 模型及推理强度设置、提示词/skills/schema 编辑、revision 冲突、持久存储/文件锁、内部管理接口及代理、Web 设置与主题、Docker 挂载。

**内容证据**：74 个对应路径均存在主干。大量新设置文件与主干完全相同：Controller local-catalog/cli-metadata/contracts/registry/tools/routes；Gateway executable、settings models/progress-tool/resources；Web api/settings、AppearanceSettings、ResourceEditor、SettingsWorkspace、contract、useThemePreference、settings.css；docs/settings-contract.md，以及多个对应测试。部分 delete/modify 冲突工作文件也与主干相同。

已读仍不同的核心实现，差异主要为**主干后续增强**：

- gateway-client.ts：主干新增微信聊天目录与历史读取代理、请求/响应校验。
- local-lock.ts：主干记录本进程 owner/inode，处理锁初始化时本进程暂时空文件窗口。
- local-storage.ts：主干改默认目录为 controller-runtime/settings，新增有界、TTL、私有权限/fsync 的 turn snapshots，并确保清理失败时仍释放锁。
- local-service.ts：主干兼容解析失败工具 schema 回退，并提供 turn snapshot 持久/读取入口。
- Gateway server/service：主干新增 leader-history、cursor/context/limit 校验，未开启线程时返回空历史；冻结 skills 失败时清理临时 home。
- Web ModelSettings：主干只读 scope 不请求/刷新可编辑目录，并用 scope.editable 与 current.editable 联合判断可写。
- Web ResourcesSection：主干保存后清 dirty，切换 chat 时清旧选中资源，避免旧对象残留。

因此没有证据支持“设置整块未合”。旧冲突仍留在本地，属于未收尾的集成副本；本报告没有继续 cherry-pick 或移除它。74 个路径的状态和整文件对照在附录。测试文件不同并不自动表示测试缺失，需按主干后续场景比较后再迁移。

## remediation-59/61/62/69：已抽核的尾部补丁

这些分支与固定主干无共同 merge base，不能用 ahead/behind 或 `main..branch` 的提交计数判断漏合。

### rem59：已核对的尾部内容均可在主干找到

- a387b19 opaque node ID：旧把 nodeId 改为非空 <=64 字符，session ID 保持既有格式；main send-availability.ts:10–15 保留相同实现。
- 0e0df4f height-only rerender geometry：主干 scroll hook 已有对应 geometry/viewport 优化；这不代表 F11 其他连续性问题也已解决。
- d7061c2 历史读取权限：main hub.ts:156 与 session-history.ts:64 均检查 read 能力。

### rem61：direct steer 撤权与恢复已吸收

c6b9029 的关键源码点均在主干：

- contracts.ts:25、99：MAX_COMMAND_IDS 与 schema 边界。
- direct-executor.ts:164、177：expired steer context 恢复、recoverSteerReceipt。
- 第 254、390 行：开始新 mutation 和失败释放路径均恢复持久 steer 回执。
- 第 258 行：cancel_plan/cancel_goal 同 durable claim 递增 steerGeneration。
- command IDs 保留裁剪已移到 leader/persistence.ts:9，不能因原 orchestrator 行被删除就判丢失。

f21201e opaque node ID 同 rem59，主干已存在。64a3a4c 是 lifecycle fixture 包含 send-eligibility helper 的测试工具改动；本报告未逐项执行其 fixture，不能用题目或提交历史断言已运行验证。

未跟踪 .background-child-diagnostics.cjs 用于对子进程/worker 事件写诊断记录，不是线上生产入口。三个 rem 工作区 node_modules 均为指向 remediation-69/controller/node_modules 的软链接，不能算业务源码遗漏。

### rem62：无用 renderer API 清理已吸收，PG 文件是诊断脚本

6d5e98a 移除 renderMarkdown/markdownForWeChat 对外 API，统一 markdownToWeChat 的排版输出；主干 index.d.ts 无两个旧 API，index.js 亦已清理，并另增旧 checkpoint 兼容函数。

未跟踪 .pg62-run.mjs、.pg62-trace.ts、.pg62-vitest.config.mjs 是合成 PG fixture、投递链 trace、单 worker 测试配置，不是另一个未上线的定时通知实现。本报告未运行这些旧脚本。

### rem69：实现已有，额外回归测试未吸收

旧 dirty service.ts 去 queue cursor，每轮重扫开头并保留 node 并发；main 已采用同样行为（显式从 0 扫描）。

旧新增测试 `rescans a queue head that was hidden by a temporary FIFO blocker` 在 admission-race.test.ts：先有 pending blocker、同 session queued head 与 64 个其他 node 任务，解除 blocker 后 queued head 必须派发。主干该测试文件仍与旧修改前完全相同，故**该额外回归场景尚未带入**；这属于测试覆盖遗漏，不是队列实现缺失。

rem69 历史还有原生媒体序号、journal 幂等、session 保留、checkpoint fsync、worker 启动等待等多族补丁。本报告未把其全部历史逐补丁复核，不能宣称全面审计完成。

## source-available-release：独立仓库的许可工作已吸收

该目录有自己的 .git，不在主仓库 registered worktree 列表；分支 codex/source-available-release，干净，HEAD 0128939，属于旧独立副本。0128939 的改动为 7 个文件、非商业许可与泛化部署说明。

- LICENSE、NOTICE 与 main923d102 **完全相同**。
- controller/package.json、根 package.json、packages/wechat-text/package.json、web/package.json **完全相同**，license 均 PolyForm-Noncommercial-1.0.0。
- README 已被主干后续改写；main README:157–158 保留许可和商业用途书面授权说明，第 102 行链接现有生产部署文档。不能恢复整份旧 README。
- 本报告未逐句验证主干全部部署说明与该旧版的泛化程度，因此“README 每句都已吸收”不成立；已证明的是许可核心已吸收。

## 外部 792d 工作区：#57 已作内容确认

路径：`<external-worktrees>/792d/wechat-super-leader-bot`。HEAD a1e12ce，干净。

证据超过“PR 显示 MERGED”：

- `git merge-base --is-ancestor a1e12ce 96d6426` 返回 0。
- 最终分支提交 96d6426 与 squash 5b80d71 的整棵 tree 完全相同。
- 本地 a1e12ce 比最终分支少两个后续提交：474a358 原生 skill skip flag 透传、96d6426 stalled transport 测试稳定性。
- 抽核 7 个对应文件，主干除 workflow 后续升级 macos15 外，其余 6 个 blob 与 final/squash 相同；AppArmor 仅 integration 条件仍保留。

结论：该旧 checkout 不能证明主干漏合；这里反而是本地副本少两个后来修复。

## 后续处理清单与尚未证明的内容

1. 当前提醒修复先完成并验证：全局 quota/context token、主动续期提醒、到期积压补发；保持 23 小时窗口和 22 小时提醒，不顺手迁移旧遗留包。
2. 将 F1、F2、F3、F4、F6、F7、F8 分为独立修复，逐个重现、迁移最小补丁与回归。
3. F9、F10、F11 只补缺失行为，保留主干已吸收的时间戳、线程身份、readGeneration、scroll 优化。
4. rem69 的 FIFO blocker 回归测试可单独补入；实现不需回退。
5. 对 rem59/61/62/69 其余历史建立“旧 patch → 当前功能/测试证据”映射后才能回答整个仓库最终遗漏总数。稳定 patch-id、合并标记、提交数量仅用于候选定位。
6. 本报告未执行旧业务测试、PG 诊断脚本、生产部署或微信发送。源码存在只能证明内容覆盖，不证明线上版本已更新或场景实际有效。
7. 没有删除或改写旧工作区，避免破坏证据和其他在途任务。

可改进的工作约定（仅建议，未修改 CLAUDE/rules/skills）：合并前记录旧 worktree 的 tracked dirty 与新增源码，按功能登记“已经进入主干的内容证据”和“实际部署 revision”；合入 PR 与清空旧工作区不能互相代替。集成未提交文件前必须先明确文件语义及已存在的替代实现。

## 复核方法

每个 dirty tracked 文件都读取工作文件、旧 HEAD 与 main923d102，对比 bytes。附录中的“主干仍等于旧修改前”仅是文件级事实，仍需结合上面的行为核对；“内容不同”也不能直接证明功能缺失。

可复现基本命令：

```sh
repo_root=$(git rev-parse --show-toplevel)
legacy_worktree="$repo_root/.claude/worktrees/<legacy-worktree>"
GIT_OPTIONAL_LOCKS=0 git -C "$legacy_worktree" status --porcelain=v1 -uall
git -C "$repo_root" show 923d102:path/to/file
git -C "$legacy_worktree" diff HEAD -- path/to/file
git -C "$repo_root" grep -n needle 923d102 -- relevant/path
```

采用内容对照而不是历史等同推断，符合 Git 对 squash 和 diff 的实际语义；方法资料见 [Git diff 官方文档](https://git-scm.com/docs/git-diff) 与 [Git 合并/冲突说明](https://git-scm.com/docs/user-manual)。外部资料只用于校准 Git 方法，本仓库的吸收结论均来自上述本地源码。

## 附录：逐文件状态与内容对应

以下表格为同一只读审计过程中机器生成；省略 250 个 .native-test-build 可重建 JS/d.ts 输出，仅记录其数量。标记口径：

- **与主干完全相同**：工作文件 bytes 等于 923d102 对应文件。
- **主干仍等于旧修改前**：主干 bytes 等于该旧目录 HEAD 文件，工作文件不同。
- **内容不同，按正文判定**：三者存在差异，须依正文判断重构、部分吸收或未吸收。
- **主干无同名文件**：只证明路径不存在，不排除正文所列替代实现。

### 主仓库

| 状态 | 路径 | 与固定主干内容关系 |
|---|---|---|
|  M | `README.md` | 内容不同，按正文判定 |
|  M | `daemon/pkg/automation/rollout.go` | 与主干完全相同 |
|  M | `daemon/pkg/automation/rollout_test.go` | 与主干完全相同 |

### fix-audit-regressions-20261023

| 状态 | 路径 | 与固定主干内容关系 |
|---|---|---|
|  M | `controller/src/automations/contracts.ts` | 主干仍等于旧修改前 |
|  M | `controller/src/automations/state.ts` | 主干仍等于旧修改前 |
|  M | `controller/src/background/contracts.ts` | 主干仍等于旧修改前 |
|  M | `controller/src/background/service.ts` | 内容不同，按正文判定 |
|  M | `controller/src/http/server.ts` | 内容不同，按正文判定 |
|  M | `controller/src/leader/background-tools.ts` | 主干仍等于旧修改前 |
|  M | `controller/src/leader/direct-contracts.ts` | 主干仍等于旧修改前 |
|  M | `controller/src/leader/direct-executor.ts` | 内容不同，按正文判定 |
|  M | `controller/src/leader/direct-journal.ts` | 主干仍等于旧修改前 |
|  M | `controller/src/leader/model/background-authorization.ts` | 内容不同，按正文判定 |
|  M | `controller/src/leader/model/user-authorization.ts` | 内容不同，按正文判定 |
|  M | `controller/src/leader/orchestrator.ts` | 内容不同，按正文判定 |
|  M | `controller/src/leader/queries/resolver.ts` | 内容不同，按正文判定 |
|  M | `controller/src/nodes/hub.ts` | 内容不同，按正文判定 |
|  M | `controller/src/notifications/model-progress.ts` | 内容不同，按正文判定 |
|  M | `controller/src/store/memory.ts` | 内容不同，按正文判定 |
|  M | `controller/src/store/notification-progress-postgres.ts` | 主干仍等于旧修改前 |
|  M | `controller/tests/background-expiry-boundary.test.ts` | 主干仍等于旧修改前 |
|  M | `controller/tests/background-service.test.ts` | 内容不同，按正文判定 |
|  M | `controller/tests/leader/background-authorization.test.ts` | 主干仍等于旧修改前 |
|  M | `controller/tests/leader/background-tools.test.ts` | 主干仍等于旧修改前 |
|  M | `controller/tests/leader/direct-background.test.ts` | 主干仍等于旧修改前 |
|  M | `controller/tests/leader/direct-executor.test.ts` | 主干仍等于旧修改前 |
|  M | `controller/tests/leader/direct-journal.test.ts` | 主干仍等于旧修改前 |
|  M | `controller/tests/leader/queries/resolver.test.ts` | 主干仍等于旧修改前 |
|  M | `controller/tests/nodes/session-history-hub.test.ts` | 内容不同，按正文判定 |
|  M | `controller/tests/nodes/turn-hub.test.ts` | 主干仍等于旧修改前 |
|  M | `controller/tests/notifications/model-progress-real-postgres.test.ts` | 主干仍等于旧修改前 |
|  M | `controller/tests/notifications/model-progress.test.ts` | 主干仍等于旧修改前 |
|  M | `controller/tests/notifications/notification-progress.test.ts` | 主干仍等于旧修改前 |
|  M | `controller/tests/notifications/notification-store.test.ts` | 内容不同，按正文判定 |
|  M | `daemon/pkg/codex/desktop/history.go` | 主干仍等于旧修改前 |
|  M | `daemon/pkg/codex/desktop/history_source_test.go` | 主干仍等于旧修改前 |
|  M | `daemon/pkg/codex/desktop/history_stream.go` | 主干仍等于旧修改前 |
|  M | `gateway/src/controller/direct-tools.ts` | 主干仍等于旧修改前 |
|  M | `gateway/src/controller/message-stream.ts` | 主干仍等于旧修改前 |
|  M | `gateway/src/gateway.ts` | 内容不同，按正文判定 |
|  M | `gateway/src/leader/app-server.ts` | 内容不同，按正文判定 |
|  M | `gateway/src/leader/codex.ts` | 内容不同，按正文判定 |
|  M | `gateway/src/leader/control-mcp.ts` | 内容不同，按正文判定 |
|  M | `gateway/src/leader/workspace.ts` | 内容不同，按正文判定 |
|  M | `gateway/src/runtime/inbox.ts` | 内容不同，按正文判定 |
|  M | `gateway/src/wechat/client.ts` | 内容不同，按正文判定 |
|  M | `gateway/tests/controller/message-stream.test.ts` | 主干仍等于旧修改前 |
|  M | `gateway/tests/leader/app-server.test.ts` | 内容不同，按正文判定 |
|  M | `gateway/tests/leader/codex-recovery.test.ts` | 内容不同，按正文判定 |
|  M | `gateway/tests/leader/control-mcp.test.ts` | 内容不同，按正文判定 |
|  M | `gateway/tests/leader/workspace.test.ts` | 内容不同，按正文判定 |
|  M | `gateway/tests/runtime/inbox.test.ts` | 内容不同，按正文判定 |
|  M | `gateway/tests/wechat/poll-budget.test.ts` | 内容不同，按正文判定 |
|  M | `web/src/features/sessions/useHistoryScroll.ts` | 内容不同，按正文判定 |
| ?? | `controller/src/background/deadline.ts` | 主干无同名文件 |
| ?? | `controller/tests/background-deadline.test.ts` | 主干无同名文件 |
| ?? | `controller/tests/http/rules-session-directory.test.ts` | 主干无同名文件 |
| ?? | `controller/tests/nodes/command-write-lifecycle.test.ts` | 主干无同名文件 |
| ?? | `controller/tests/notifications/model-progress-fairness.test.ts` | 主干无同名文件 |
| ?? | `daemon/pkg/codex/desktop/history_cursor_retention_test.go` | 主干无同名文件 |
| ?? | `daemon/pkg/codex/desktop/history_cursors.go` | 主干无同名文件 |
| ?? | `gateway/tests/gateway/inbound-validation.test.ts` | 主干无同名文件 |
| ?? | `gateway/tests/leader/codex-native-supplements.test.ts` | 主干无同名文件 |
| ?? | `web/tests/sessions/history-state-continuity.test.tsx` | 主干无同名文件 |

另有 250 个 .native-test-build 可重建产物，未逐项列出。

### publish-remediation-main

| 状态 | 路径 | 与固定主干内容关系 |
|---|---|---|
| MM | `controller/src/commands/service.ts` | 内容不同，按正文判定 |
| M  | `controller/src/deliveries/memory.ts` | 内容不同，按正文判定 |
| M  | `controller/src/runtime/task-notifications.ts` | 内容不同，按正文判定 |
| M  | `controller/src/store/command-queue-postgres.ts` | 与主干完全相同 |
| M  | `controller/src/store/interface.ts` | 与主干完全相同 |
| M  | `controller/src/store/memory.ts` | 与主干完全相同 |
| M  | `controller/src/store/postgres.ts` | 与主干完全相同 |
| M  | `controller/tests/commands/admission-store.test.ts` | 与主干完全相同 |
| M  | `controller/tests/commands/queue.test.ts` | 与主干完全相同 |
| M  | `gateway/src/gateway.ts` | 与主干完全相同 |
| M  | `gateway/src/types.ts` | 与主干完全相同 |
| M  | `gateway/src/wechat/client.ts` | 内容不同，按正文判定 |
| M  | `gateway/tests/gateway/notification-recovery.test.ts` | 与主干完全相同 |
| M  | `gateway/tests/results/gateway-wiring.test.ts` | 与主干完全相同 |
| M  | `gateway/tests/wechat/poll-budget.test.ts` | 与主干完全相同 |

### wechat-settings-on-head

| 状态 | 路径 | 与固定主干内容关系 |
|---|---|---|
| M  | `README.md` | 内容不同，按正文判定 |
| M  | `compose.yaml` | 内容不同，按正文判定 |
| DU | `controller/src/background/worker/contracts.ts` | 内容不同，按正文判定 |
| DU | `controller/src/background/worker/executor.ts` | 与主干完全相同 |
| DU | `controller/src/background/worker/output.ts` | 内容不同，按正文判定 |
| DU | `controller/src/background/worker/runtime.ts` | 内容不同，按正文判定 |
| UU | `controller/src/console/access.ts` | 内容不同，按正文判定 |
| DU | `controller/src/deliveries/service.ts` | 内容不同，按正文判定 |
| UU | `controller/src/http/server.ts` | 内容不同，按正文判定 |
| DU | `controller/src/leader/direct-executor.ts` | 内容不同，按正文判定 |
| M  | `controller/src/leader/goals/model.ts` | 内容不同，按正文判定 |
| DU | `controller/src/leader/model/automation-authorization.ts` | 与主干完全相同 |
| DU | `controller/src/leader/model/background-authorization.ts` | 与主干完全相同 |
| M  | `controller/src/leader/model/client.ts` | 内容不同，按正文判定 |
| M  | `controller/src/leader/model/responses.ts` | 与主干完全相同 |
| UU | `controller/src/leader/model/user-authorization.ts` | 内容不同，按正文判定 |
| UU | `controller/src/leader/orchestrator.ts` | 内容不同，按正文判定 |
| M  | `controller/src/leader/queries/session-images.ts` | 内容不同，按正文判定 |
| DU | `controller/src/notifications/model-progress.ts` | 内容不同，按正文判定 |
| DU | `controller/src/runtime/background.ts` | 与主干完全相同 |
| UU | `controller/src/runtime/config.ts` | 内容不同，按正文判定 |
| DU | `controller/src/runtime/task-notifications.ts` | 内容不同，按正文判定 |
| A  | `controller/src/settings/gateway-client.ts` | 内容不同，按正文判定 |
| A  | `controller/src/settings/local-catalog.ts` | 与主干完全相同 |
| A  | `controller/src/settings/local-cli-metadata.ts` | 与主干完全相同 |
| A  | `controller/src/settings/local-contracts.ts` | 与主干完全相同 |
| A  | `controller/src/settings/local-lock.ts` | 内容不同，按正文判定 |
| A  | `controller/src/settings/local-registry.ts` | 与主干完全相同 |
| A  | `controller/src/settings/local-service.ts` | 内容不同，按正文判定 |
| A  | `controller/src/settings/local-storage.ts` | 内容不同，按正文判定 |
| A  | `controller/src/settings/local-tools.ts` | 与主干完全相同 |
| A  | `controller/src/settings/routes.ts` | 与主干完全相同 |
| DU | `controller/tests/background/worker/executor.test.ts` | 内容不同，按正文判定 |
| A  | `controller/tests/console/settings-http.test.ts` | 内容不同，按正文判定 |
| A  | `controller/tests/settings/local-service.test.ts` | 内容不同，按正文判定 |
| UU | `deploy/Dockerfile.controller` | 内容不同，按正文判定 |
| UU | `deploy/Dockerfile.gateway` | 内容不同，按正文判定 |
| UU | `deploy/compose.gateway.yaml` | 内容不同，按正文判定 |
| A  | `docs/settings-contract.md` | 与主干完全相同 |
| UU | `gateway/src/cli/run.ts` | 内容不同，按正文判定 |
| DU | `gateway/src/leader/app-server.ts` | 内容不同，按正文判定 |
| DU | `gateway/src/leader/codex.ts` | 内容不同，按正文判定 |
| DU | `gateway/src/leader/control-mcp.ts` | 内容不同，按正文判定 |
| A  | `gateway/src/leader/executable.ts` | 与主干完全相同 |
| DU | `gateway/src/leader/prompt.ts` | 内容不同，按正文判定 |
| DU | `gateway/src/leader/workspace.ts` | 内容不同，按正文判定 |
| A  | `gateway/src/settings/models.ts` | 与主干完全相同 |
| A  | `gateway/src/settings/progress-tool.ts` | 与主干完全相同 |
| A  | `gateway/src/settings/resources.ts` | 与主干完全相同 |
| A  | `gateway/src/settings/server.ts` | 内容不同，按正文判定 |
| A  | `gateway/src/settings/service.ts` | 内容不同，按正文判定 |
| A  | `gateway/tests/settings/models.test.ts` | 与主干完全相同 |
| A  | `gateway/tests/settings/progress-tool.test.ts` | 与主干完全相同 |
| A  | `gateway/tests/settings/resources.test.ts` | 与主干完全相同 |
| A  | `gateway/tests/settings/service.test.ts` | 内容不同，按正文判定 |
| A  | `gateway/tests/settings/skill-discovery.test.ts` | 内容不同，按正文判定 |
| UU | `web/src/App.tsx` | 内容不同，按正文判定 |
| UU | `web/src/api/request.ts` | 内容不同，按正文判定 |
| A  | `web/src/api/settings.ts` | 与主干完全相同 |
| A  | `web/src/features/settings/AppearanceSettings.tsx` | 与主干完全相同 |
| A  | `web/src/features/settings/ModelSettings.tsx` | 内容不同，按正文判定 |
| A  | `web/src/features/settings/ResourceEditor.tsx` | 与主干完全相同 |
| A  | `web/src/features/settings/ResourcesSection.tsx` | 内容不同，按正文判定 |
| A  | `web/src/features/settings/SettingsWorkspace.tsx` | 与主干完全相同 |
| A  | `web/src/features/settings/contract.ts` | 与主干完全相同 |
| A  | `web/src/features/settings/useThemePreference.ts` | 与主干完全相同 |
| UU | `web/src/index.css` | 内容不同，按正文判定 |
| A  | `web/src/styles/settings.css` | 与主干完全相同 |
| DU | `web/tests/app/mobile-shell.test.tsx` | 与主干完全相同 |
| A  | `web/tests/app/model-settings-conflict.test.tsx` | 内容不同，按正文判定 |
| A  | `web/tests/app/resource-editor.test.tsx` | 与主干完全相同 |
| A  | `web/tests/app/settings-api.test.ts` | 与主干完全相同 |
| A  | `web/tests/app/settings-workspace.test.tsx` | 与主干完全相同 |
| A  | `web/tests/app/theme-preference.test.tsx` | 与主干完全相同 |

### remediation-59

| 状态 | 路径 | 与固定主干内容关系 |
|---|---|---|
| ?? | `controller/node_modules` | 软链接 → <repo-root>/.claude/worktrees/remediation-69/controller/node_modules |

### remediation-61

| 状态 | 路径 | 与固定主干内容关系 |
|---|---|---|
| ?? | `controller/.background-child-diagnostics.cjs` | 主干无同名文件 |
| ?? | `controller/node_modules` | 软链接 → <repo-root>/.claude/worktrees/remediation-69/controller/node_modules |

### remediation-62

| 状态 | 路径 | 与固定主干内容关系 |
|---|---|---|
| ?? | `.pg62-run.mjs` | 主干无同名文件 |
| ?? | `.pg62-trace.ts` | 主干无同名文件 |
| ?? | `.pg62-vitest.config.mjs` | 主干无同名文件 |
| ?? | `controller/node_modules` | 软链接 → <repo-root>/.claude/worktrees/remediation-69/controller/node_modules |

### remediation-69

| 状态 | 路径 | 与固定主干内容关系 |
|---|---|---|
|  M | `controller/src/commands/service.ts` | 内容不同，按正文判定 |
|  M | `controller/tests/commands/admission-race.test.ts` | 主干仍等于旧修改前 |
