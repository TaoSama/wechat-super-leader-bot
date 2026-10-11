# 原终端控制链路

## 目标与授权边界

沿用 Controller 唯一编排权威、宿主 Go Daemon 和原终端 pane。把已验证的输入投递模块接入实际命令链路、持久回执和展示，但不谎称任务完成。不得改 App transport、启动/恢复 Agent、解析默认焦点或绕到另一宿主。此轮仅在合成 socket 和临时数据库启用，生产不开启。

原 PTY 输入无法原子绑定到 CLI 进程 incarnation；进程退出/替换和人工输入竞态仍存在。默认关闭。未来操作者必须显式使用 `--terminal-send-mode=non-atomic`，同时配置已有 socket 和明确 pane 清单；不存在隐式开启或自动降级。真实启用仍需用户选择与精确 pane 验收。

## 跨语言契约

- `SendRoute` 新增 `terminal-pane`；终端目标仅接受此路由，其他目标不可用此路由。禁止 fallback。
- `SendAvailability` 使用区分路线的联合：原桌面字段不变；终端路线额外要求 `mode: "non-atomic"`，其余为 `state / observedAt / validUntil / reason?`，同样最多 45 秒。终端资格由独立只读预检产生，不伪造 native loaded/turn。
- `DaemonResultStatus / CommandStatus` 新增 `input-written`。这仅终结本条输入投递，不表示 Agent 开始、执行成功或完成。终端发送只能返回 `input-written / failed / uncertain`；禁止 `accepted / completed / turnId`。read 与原生发送不得使用此状态或终端回执。
- `input-written` 必须包含 `inputReceipt`：`{kind:"terminal-input-written",sessionId,requestId,promptSHA256,responseRevision,observedRevision}`。`requestId` 为 Daemon 预分配 UUIDv4，不是 HTTP requestId；摘要为 64 位小写十六进制；revision 为非负安全整数（最多 2^53−1），observed >= response。不得包含 socket、私有 session 路径、prompt 或虚构输出。线上 result 的 output 必须为空，不带 error/turnId；HTTP command 可省略空输出。其他状态不得携带该回执。
- `result_ack` 对 `input-written` 必须带完全一致的 `inputReceipt`，只有精确持久回执可确认。既有原生 turn ACK 规则不变。
- Controller 校验已登记命令的 node / action / route / session；首次合法回执绑定，之后不得替换 proof、倒退状态、进入原生 turn 检查或提升为 completed。PG 与内存 store 使用同一合同；新增持久列，不新建兼容协议。
- Web/微信文案明确“输入已写入，执行未确认”，显示独立状态。终端单步确认预览必须显示非原子边界；持久依赖计划拒绝终端路线，不会通过 idle、快照或该回执解锁依赖。

## Daemon 与 journal

复用既有 journal、容量约束、结果重放和 ACK 流程。Begin 在任何副作用前原子领取 command，终端 claim 预生成唯一 request UUID；同 command 的 payload 不符拒绝，既有 claim 永不重复执行。准备阶段零输入；保存完整冻结身份（投递模块现有全部标量字段）后才能 Dispatch。身份不可重绑定，摘要对应实际投递文本（包含已核对技能注入），不持久保存 prompt。

准备后、绑定后和派发前检查过期/取消。Dispatch 只尝试一次，Close 错误不能遗漏；可能开始写入后出现的任何错误均 uncertain。仅投递成功、后检成功、清理成功才能落下 input-written。未保存结果的进程重启恢复为 uncertain，不重新 Prepare 或 Dispatch。结果保存失败保留既有内存重试机制，仅重试保存，不重试副作用。

终端发送强制要求持久 journal；in-memory fixture 构造不能绕过。默认配置仍只读，生产服务参数只在操作者明确传入该模式时保留。对现有原 App/native 发送规则、历史、只读终端快照无影响。

## 并行所有权与验证

- Go 实现单元：`daemon/`，包括协议、journal、client、配置/服务参数和测试；不编辑文档、Controller、Web 或根验证入口。
- TS 实现单元：`controller/` 与 `web/`，包括持久化、路由、计划保护、回执展示和测试；不编辑 Daemon、文档、根验证入口。不得新增协作单元。
- 主控：合同、整链运行脚本/证据、交叉评审、实际运行与收口。

必须通过真实 Go + 临时 PG + HTTP/WebSocket 的合成宿主链路：默认关闭、启用后唯一精确投递、无 turn/completed、重复 request/command 与进程重启零重发、错误 ACK 不确认、正确 ACK 清理 pending、身份变化零输入、丢回执 uncertain、原生路线不变、依赖计划拒绝。公开运行证据与单元测试分开，不能冒充真实微信或真实 CLI 验收。
