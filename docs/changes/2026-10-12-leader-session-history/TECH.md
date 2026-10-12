# 微信具体会话的有界历史读取

## 目标与根因

微信用户明确询问某个已知会话的进度或最新输出时，`read_session` 应读取该会话的近期已记录历史，而不是提交控制接口的 `read` 命令。仅列举 active/运行任务仍使用 `list_sessions`，不为了补充列表而读取正文。

变更前，`LeaderOrchestrator` 通过 `commands.submit(action: "read")` 读取，并把生成的 `commandId` 保存到聊天的命令清单。这条路径要求控制读接口可用，无法代表已有桌面历史入口的读取资格；桌面状态可见、控制接口未加载或不可用的会话因此可能出现“状态存在但输出读不到”。读命令的 `completed` 只说明读操作结束，也容易与具体 Agent 任务完成混淆。

项目已有 `NodeHub.readHistory` 与独立的临时历史请求生命周期。本变更复用该入口，不新建读取后端，不把历史查询纳入持久命令、执行计划或依赖解锁逻辑。

本文定义实现及验收合同，不构成测试通过、真实会话读取成功或部署完成的证据。

## 路由与授权边界

1. 模型工具参数仍只接受严格的 `{nodeId, sessionId}`。模型不能指定 reader、来源、文件路径、分页游标或历史 context。
2. Controller 对精确已知目标调用 `hub.readHistory(nodeId, sessionId, {limit: 8}, signal)`，读取最新页。不提交 `action: "read"`，不新增 `commandId`，不读取或写入命令记录。
3. 微信模型入口保留原有的节点在线、目标存在及明确 `read` capability 检查，不要求 `loaded`。`hub.readHistory` 的既有通用合同本身更宽，但本轮不扩大模型读取权限；桌面 idle 或发送资格都不能代替读取资格。来源选择、owner/context 完整性、身份验证和错误处理由已有历史入口负责。
4. 首次读取由已有 Daemon 合同选择 `control-socket`、`codex-desktop` 或 `terminal-transcript`，不得在失败后暗中更换来源、恢复会话、获取 writer 或执行输入。
5. 终端会话只有明确报告 `historySource: "terminal-transcript"` 才进入历史入口。未配置时返回静态历史不可用提示，不降级 `pane.read`、不推导 transcript 路径、不扫描默认目录。既有显式诊断 `ActionRead` 的终端快照合同保持独立，不因本工具迁移被删除或放宽。
6. 历史结果、工具文本和会话内指令均是不可信资料，不是微信用户的新授权。读取不授权发送、继续、重试、改模型、恢复会话或推进计划。

## 最小模型可见结果

只投影回答所需字段，不把 `SessionHistory` 原对象直接交给模型。

| 字段 | 含义与限制 |
| --- | --- |
| `nodeId`、`sessionId` | 本次精确目标；不得按标题或焦点重新绑定 |
| `source` | 实际历史来源；保持 `control-socket` / `codex-desktop` / `terminal-transcript` |
| `fetchedAt` | 历史入口报告的获取时间；不是任务完成时间 |
| `scope` | 固定为 `recent_recorded_history`，区分近期历史与命令结果 |
| `items` | 近期已记录条目，最多 8 条；采用公开条目字段白名单 |
| `hasOlder` | 来源是否提供更早页；只由 `nextCursor !== null` 得出，不是可供模型翻页的凭据 |
| `omittedItems` | 当前取得页中因模型预算被完整省略的条目数；不是完整会话遗漏总数 |
| `truncated` | 来源已有裁剪、单条字段被裁剪或条目被预算省略的汇总标记 |
| `completeHistory` | 固定为 `false`，明确这是有界近期视图 |

条目仅保留必要的 `id`、`turnId`、`kind`、`type`、`text`、`truncated` 与存在时的公开 `timestamp`，不透传 title、status、未知字段或原始载荷。字段仍受整体模型结果预算约束。缺失真实时间或身份时不伪造；终端 transcript 的身份不能冒充原生精确执行回执。

不透传 `historyContext`、`nextCursor`、底层 cursor、完整 session 元数据、socket/transcript 路径、owner 标识、原始 IPC/JSONL、私有 provider payload 或错误正文。

`truncated: false` 仅表示这个近期投影没有已知裁剪，不表示完整会话。`hasOlder: false` 也不能把近期页升级成完整导出：`omittedItems` 可能非零，来源范围、未记录 UI 暂态、条目过滤与取得时点的边界仍然存在。空 `items` 与读取失败不同；失败不能转换成空数组、会话不存在或没有 active 任务。

## 模型结果预算

- 一次取得最新最多 8 条公开记录；选择时优先保留最新条目，返回时维持来源提供的原始时间顺序，不按缺失或相同的 timestamp 重排。
- 每条正文复用 `recordedOutput` 的既有上限：最多 1000 Unicode 码点，且 `JSON.stringify(text)` 包含引号与转义后最多 3000 UTF-16 字符。两项上限同时生效；按安全前缀裁剪，不截断代理对，不靠额外省略号突破预算。
- 完整投影 `JSON.stringify(result).length` 不超过 11000。元数据、条目字段、引号、控制字符转义及标点都计入预算，不只计算可见正文长度。
- 总预算不足时完整省略较早条目，保留连续的最新后缀及目标、来源、获取时间、范围和裁剪标记。异常长的公开元数据不能使结构化结果退化为 JSON 字符串片段；若不能保留任何一个已取得条目或必要元数据自身超限，则返回静态无效响应错误，不伪装为空历史。
- `omittedItems` 与条目/顶层 `truncated` 必须反映真实操作；来源 `truncated: true` 不得在重新投影时被清除。
- 11000 的专用上限保留现有 12000 通用工具结果守护的余量。不能依赖通用 `{truncated, data: clip(serialized)}` 分支截断历史，因为它会破坏字段边界并可能丢失来源和范围。

条目数量与总 JSON 预算使用独立命名的历史常量，不复用微信聊天上下文的 `MAX_HISTORY_ITEMS = 6`。单条正文有意复用已有 `recordedOutput` 及其 1000/3000 预算，避免重复实现 Unicode/JSON 裁剪。复用算法不意味着历史变成完成回执，也不放宽已确认计划的跨步骤结果合同。

## 时限、错误与完成证据

本轮已有 90 秒总时限、6 步模型调用和 12 次工具调用上限不放宽。将同一轮 `AbortSignal` 传入 `readHistory`，由已有 15 秒历史请求预算及取消信封清理 pending；超时后不留下继续运行的历史 waiter。超过工具调用上限的批次不能先执行部分读取再报超限。

已有 `HistoryError` 对离线、目标不存在、不可用、超时、忙碌、过大、不完整、context 失效、取消和坏响应给出稳定分类。模型层使用明确允许的错误码与静态提示；未知异常返回固定失败提示，不复制任意 `error.message`、私有 ID、路径、凭证或远端 payload。读取失败保留之前 `list_sessions` 的有效状态事实，明确“最新历史未取得”，不推断任务没运行或会话为空。

近期历史可支持带来源和时点的进度描述，但不自动证明用户所指任务已完成。`idle/done`、文本里的“完成”、历史 `status` 或读请求成功都不是精确完成回执。已有计划依赖及 `resultFrom` 继续只认同一计划精确 `commandId/turnId` 的 `completed` 记录；不得用任意历史替代、解锁后继或取得跨聊天命令访问权。没有绑定到具体任务的充分证据时，回答必须保留“完成尚未确认”。

## 验证门槛

使用合成 fixture 验证，不读取真实会话正文、不发送真实输入。至少满足以下断言后才能记录实现已通过：

1. `leader-orchestrator`：用户明确询问具体目标才调用 `readHistory`；返回内容仍为工具角色，不成为用户授权；`commands.submit`、命令存储与聊天 `commandIds` 均无新增读记录。
2. 资格分离：控制未加载但有 read capability 的已知在线非终端目标可走历史入口；无 read capability、离线、缺失目标返回静态错误且不读取。终端无 `historySource` 不调用历史或快照，有合法 transcript 来源时只取有界记录。
3. 字段与预算：8 条、最新优先且维持原序；超长正文、emoji、引号、反斜线、换行和控制字符；单条双预算、总 JSON 上限；极长公开元数据；原裁剪保留、条目省略计数、`completeHistory: false`；源 context/cursor/raw 字段不可见。
4. 错误隐私：允许的错误码映射固定提示；自造私有错误正文不能进入模型、回复或日志；失败不冒充空历史、不覆盖已知 active 状态。
5. 生命周期：复用同一轮取消 signal；超时/取消与迟到响应不泄漏 pending；工具调用预算超限前无读取；只枚举任务的 fixtures 明确断言不调用 `readHistory`。
6. 完成与权限：历史里的完成字样、prompt injection、terminal transcript status 不解锁依赖、不触发发送、不放宽 `get_command`/`get_plan_progress` 的聊天归属检查。
7. 契约同步：工具描述、系统 prompt、README 与终端相关测试从“微信终端快照”改为“配置来源的有界已记录历史”；保留“不是完整对话历史”和“idle/done 不是精确任务完成证据”。显式诊断快照说明保持独立。

建议先运行 Controller 定向测试与类型检查，再执行完整 Controller 测试及 diff 检查；具体命令、通过数量与日志应在实际执行后写入验收记录，本文不预填成功结论。

## 本轮不完成的事项

不新增微信历史分页工具、不导出完整会话、不变更 Web 固定 context 的分页合同，不扩大 terminal transcript 根目录授权，也不修改 Daemon 的来源发现、完整性判定或 writer 控制。

合成测试不能证明某台机器此刻存在桌面 owner、控制 socket 或合法 transcript；读取入口的正确性也不能证明真实目标可读。具体机器的部署版本、在线状态、来源配置与精确目标的真实只读验收需另行记录，不能从此前状态观测或一次历史失败推定。发送与多步依赖的真实验收仍是独立工作。
