# 原 CLI 结构化历史

## 目标与范围

为显式选定的既有终端会话读取结构化聊天记录，供 Web 实时刷新与向上分页。保持原 Agent 进程和原终端，不启动、恢复、重建、抢占或改变桌面连接。终端快照仍是独立的只读能力，不作为历史兜底。本阶段不证明真实终端发送、精确完成关联或完整动态自治。

## 授权与身份

- 新增可重复 `--terminal-history-root <codex|claude|grok>=<绝对记录目录>`，每提供方最多一个目录，默认无目录。要求已显式设置 socket 与 pane；不使用环境变量或默认 home 推导授权，不复用仅授权元数据发现的 `--codex-home`。
- 根目录是记录目录本身，而非配置目录；格式和相对布局以实现及验收为准，不能读取任意会话给出的 path。只接受终端协议提供的精确可信 source/agent 对和 kind=id。
- `terminal:<hash>` 继续绑定 socket/pane/terminal/workspace/tab/provider/原始会话引用。每次历史读取在同一终端连接上前后检查绑定与非倒退 revision；允许 working/blocked，不要求发送资格。
- 新增可选 Session `historySource: "terminal-transcript"`，仅表示显式目录配置与受支持绑定具备按需读取路线，并不保证文件存在。只有 terminal 公有 ID 与受支持 terminal provider 可以发布。发现过程不扫描记录正文。
- 每次读取安全锚定根目录与常规文件，拒绝符号链接越界、特殊文件、重复匹配、身份不一致和任意路径引用。错误返回固定协议消息，不泄露私有路径或原始记录。

## 分页与来源

- SessionHistory.source 增加 `terminal-transcript`。terminal ID 只能返回该来源，native ID 不可返回该来源。
- 复用现有 historyContext：绑定 node/session/source；内部 generation 绑定文件，外部 cursor 随机化，不携带路径、socket 或原生会话 ID。
- 读取最近页；更早页使用固定边界，不因新内容追加而移动。刷新看到追加内容；改写已读前缀、缩短、替换文件或绑定变化使旧 context 失效，不自动换来源。
- generation 缓存最多128条、闲置10分钟过期；断开 Controller 时重置。无发送/命令 journal 写入。
- 源文件最多32 MiB、单行最多2 MiB、目录枚举最多50000项/深度8；超过预算明确失败。每次流式验证完整有界文件并保留分页所需有限项，不缓存全量文本。最多4并行历史读取，页最多50项，编码 items预算256 KiB，完整响应小于1 MiB；单项文本同时限制UTF-8字节与UTF-16长度。
- 仅公开用户/助手可见文本；隐藏推理、系统/开发者指令、未知事件与隐含凭据元数据不转发。无真实 turn ID 时留空，不能伪造执行回执。支持格式和不支持的变体必须明确列出。
- 新来源的条目类型仅允许 `transcript_message` 或 `transcript_chunk`。Codex/Claude 发布可见消息，Grok ACP 发布原始可见文本片段并明确标注“文本片段（非完整轮次）”，不推断消息结束或完成证明；Grok 可见片段必须逐条携带精确匹配的 sessionId。

## 接口与所有权

### 记录格式

| 提供方 | 显式根下的布局 | 可见文本与身份要求 |
| --- | --- | --- |
| Codex | 日期子目录的 `rollout-…-<UUID>.jsonl`，或 `<UUID>_*.jsonl` | 首行 `session_meta.payload.id` 精确匹配；source 只能缺省或 `cli`；`response_item` 的 user/assistant message，仅 input_text/output_text，assistant phase 限缺省/commentary/final |
| Claude | `<project>/<UUID>.jsonl` | 每条 user/assistant 均有相同 sessionId 与匹配 message.role；仅 string/text 内容，排除 sidechain 与 thinking/tool 内容 |
| Grok | `<project>/<session-id>/updates.jsonl` | ACP session/update 中 user_message_chunk/agent_message_chunk，每条必须携带精确 sessionId；仅 text 内容 |

仅完整换行 JSONL 被发布；末尾半行标明裁剪并留待下一次追加，不输出部分 JSON。完整非法行、重复字段、身份冲突和非法 Unicode 明确失败。未知事件、系统/开发者文本、推理及工具载荷不作为可见记录。

不支持任意 path 引用、整文件 JSON 快照、推断缺失 Grok sessionId、重建 Claude 分支或重复 assistant 流、推断 Grok 消息边界。日志里的可见用户文本仍可能包含用户自行输入的敏感内容；过滤元数据不等于对正文作秘密扫描。

### Reader API

- `transcript.New(Config{Roots map[string]string}) *Reader`；`Reader.Supports(Ref) bool`；`Reader.Read(ctx, Ref, generation, cursor, limit) (Page, nextGeneration, error)`；`Reset()`。
- `terminal.NewHistoryReader(observer, *transcript.Reader) *HistoryReader`；`Supports(publicID) bool`；`ReadHistory(ctx, publicID, generation, cursor, limit) (protocol.SessionHistory, string, error)`；`Reset()`。
- Daemon 独立持有 terminal history reader，按公有ID固定路由。返回 Session 使用已规范化的终端观测，不从文件产生 loaded/status/send 权限。
- Go reader 单元独占 `daemon/pkg/transcript/` 与 `daemon/pkg/terminal/history*.go`；TS/Web 单元独占 `controller/` 与 `web/` 的必要增量；主控拥有配置/服务/协议/Daemon接线、根验收入口和文档。跨边界修改先协商，禁止新增协作单元。

## Web 与验证

- 无 historySource 的终端保持说明页且零历史请求；有来源时复用现有历史组件，明确标注“CLI 会话记录”。在线且终端观测在45秒内才能自动读取；过期/撤销时暂停但保留已读内容，不改变发送资格。
- 409保持已读历史并停止自动刷新，仅显式重新读取最新页开启新context。页面隐藏/离线/切换目标沿用现有取消和隔离行为。
- 必须验证：三种受支持记录格式、最新/旧页/追加、换pane/会话、前缀改写/删除/替换、符号链接/特殊文件、半行/非法输入/尺寸/取消，来源交叉拒绝，隐藏推理不泄漏。
- 主控通过真实 Go 进程、临时 PostgreSQL/Controller、HTTP/WS 与自建终端 socket 驱动读取，断言零 agent.prompt、零新命令；浏览器驱动刷新、滚动和来源失效，不使用真实账号或工作会话。
- macOS/Linux 服务仅验证生成与解析，不安装或重启生产服务。无 push 或部署；保留当前真实数据和幂等记录。
