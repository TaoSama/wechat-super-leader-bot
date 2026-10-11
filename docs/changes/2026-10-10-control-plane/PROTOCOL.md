# 当前实现协议

唯一实现由 TypeScript Controller（`controller/`）、TypeScript 微信 Gateway（`gateway/`）、Go 宿主机 Daemon（`daemon/`）与 React/TypeScript Web（`web/`）组成。旧 Python 源码、测试和依赖入口已废弃删除，不保留双版本或兼容层；数据库、微信凭证和 Daemon journal 保留。Controller 负责唯一编排权威与 PostgreSQL，Gateway 通过 HTTP 转译微信消息，Daemon 在宿主机原生运行并连接既有 Codex 控制 socket。不提供任意 shell 入口，不隐式创建 worker 或 resume 会话。

## Wire v1

`/v1` 路径与 hello 的 `version:1` 表示当前协议版本，不表示保留旧实现。Daemon 使用 `Authorization: Bearer <node token>` 主动连接 `/v1/daemon`；Controller 通过 `NODE_TOKENS` 的 `{nodeId:token}` 映射身份，拒绝重复在线节点。远端使用 WSS/HTTPS，只有本地 loopback 允许 WS/HTTP。

Daemon → Controller：

- `{type:"hello",version:1,nodeId,sessions:[Session],skills:[Skill]}`
- `{type:"heartbeat",sessions:[Session],skills:[Skill]}`，间隔 15 秒。
- `{type:"result",commandId,status:"completed"|"failed"|"accepted"|"uncertain"|"input-written",output?,error?,turnId?,inputReceipt?}`
- `{type:"history",requestId,sessionId,history?:SessionHistory,error?:string}`，成功 history 与静态 error 二者恰有一个。

Controller → Daemon：

- `{type:"command",commandId,nodeId,sessionId,action:"read"|"send",prompt?,expiresAt,skills?:[{id,digest}]}`
- `{type:"inspect_turn",commandId,nodeId,sessionId,turnId}`，只读核查指定 turn，不开始新 turn。
- `{type:"result_ack",commandId,status,turnId?}`，只在结果持久化后确认。
- `{type:"read_history",requestId:"UUID",nodeId,sessionId,cursor?,limit:30}`，独立只读历史通道。

Session 基础字段为 `{id,provider,title,cwd,status,capabilities,observedAt}`，另有可选 `{model,modelProvider,reasoningEffort,updatedAt,preview,loaded}`。capabilities 是已核实能力的子集，可以为空；未知状态为 unknown，不能默认可发送。模型与 loaded 取原生 thread 数据，不以全局默认模型补造。会话身份为 nodeId + sessionId，不能只凭 ID 跨节点定位。当前 Daemon 只为已加载且 idle 的会话报告 send；控制 socket 的 loaded 不等于桌面 App 已打开，writer 归属冲突不能通过自动 resume 绕过。

## 结构化历史

SessionHistory 为 `{session:Session,items:[HistoryItem],nextCursor:string|null,fetchedAt:ISO8601,truncated:boolean}`。HistoryItem 为 `{id,turnId,kind:"user"|"assistant"|"tool"|"system",type,text,title?,status?,timestamp?,truncated?}`。首屏返回最新条目，每页按从旧到新排列，nextCursor 指向更早消息。

历史采用启用 experimentalApi 的原生 `thread/read includeTurns:false` 与 `thread/items/list` 分页；默认 limit=30，可选 1–50，cursor 最长 4096。只投影公开类型和字段，排除 reasoning/未知类型；Daemon 文本按 UTF-8 边界裁剪至 16000 字节，整体响应小于 1 MiB，并报告 truncated。接口不支持时明确报错，不读取全量 JSONL 或增加旧接口回退。

Controller 将每次历史请求绑定到 socket 实例、nodeId、sessionId、requestId，并核对内层 session.id 和页长；超时 15 秒，全局最多 32、单节点最多 8 个请求。Daemon 超时 8 秒、最多 4 个并发，历史不产生持久化 command 或 journal 回执，不堵塞心跳。Controller 的取消、断连、超时均释放待处理请求，迟到或跨目标响应不能匹配其他查询。详细数据与交互契约见 [SESSION_WORKSPACE.md](SESSION_WORKSPACE.md)，实际验证见 [VERIFICATION.md](VERIFICATION.md)。

## HTTP 与浏览器权限

`GET /health` 公开且仅用于存活检查。管理 API 通过独立 `Authorization: Bearer <CONTROLLER_TOKEN>` 认证：

- `GET /v1/status` 返回 `{nodes,sessions,commands,skills,leaderMode}`，`GET /v1/skills` 返回技能目录。
- `POST /v1/commands` 接收 `{nodeId,sessionId,action,prompt?,requestId,skills?}`，返回完整 CommandRecord；pending 为 202，其余为 200。
- `GET /v1/commands/:id` 返回包含 status/output/error/turnId 的命令记录。
- `POST /v1/messages` 接收 `{chatId,messageId,text}`，返回 `{text,commandId?}`；`ALLOWED_CHAT_IDS` 精确匹配，消息去重持久化，自然语言歧义不能隐式另开 worker。
- `POST /v1/console-links` 接收 `{requestId}`，签发固定 1 小时的一次性链接。

浏览器通过 `/auth/exchange` 的 JSON `{token}` 兑换固定 1 小时 HttpOnly/SameSite=Strict Cookie；HTTPS 使用 Secure 的 `__Host-super_leader_session`，loopback HTTP 使用 `super_leader_session`。`GET /auth/session` 查询登录状态，`POST /auth/logout` 撤销登录。链接仅可兑换一次，刷新不延长登录；浏览器不持有 Controller 管理 token。

Cookie 允许状态、技能、命令回执及精确会话历史 GET，另只允许专用消息 POST：

- `GET /v1/sessions/:nodeId/:sessionId/history?cursor=...&limit=...` 返回 SessionHistory，允许 Cookie/Bearer；拒绝未知或重复 query 字段。
- `POST /v1/sessions/:nodeId/:sessionId/messages` 严格只接受 `{prompt,requestId}`，返回 CommandRecord。prompt 为非空白且不超过 16000 字符，requestId 为 1–128 个字母、数字、下划线或连字符；路径目标为 1–64 个相同允许字符。

Cookie 消息写入必须 application/json、Origin 精确匹配 `CONSOLE_PUBLIC_URL`、`X-Super-Leader-Intent: session-message`；提供 Sec-Fetch-Site 时必须 same-origin，cross-site/same-site 均拒绝。Bearer 管理认证独立进行。服务端固定 action=send，精确使用路径 nodeId/sessionId，requestId 由 `web_` + SHA256(JSON `["session-message",requestId]`) 命名空间化，禁止提交任意 action/skills/目标字段。同 requestId 同 payload 返回原命令，改变 prompt 或目标返回 409；新命令派发前再次验证 Cookie，登录已撤销或到期则返回 401、持久化 failed 而不派发。Cookie 仍不能调用 `/v1/commands`、`/v1/messages`、`/v1/console-links` 管理写接口。

## 持久化、渠道与完成语义

派发后断连或投递不确定记为 uncertain，不能自动重发。Daemon 检查到期时间和精确节点身份，串行化会话修改，并由持久化 journal 防止同 commandId 重放。send 的 accepted 回执必须带合法且精确关联的 turnId，accepted 与 result_ack 都不等于任务完成；随后必须核查该 turn 的终态与输出。结构化历史查询与 command 的 read/send 生命周期分开。

本地源码新增结果传递所需的输出存在性语义：省略 `output` 表示没有已记录输出；明确 `output:""` 才表示已记录空结果。completed 不继承 accepted 正文。Daemon 对精确空结果显式序列化空串，已 ACK 且正文已裁除的 journal 记录不重新报告为空结果；缺失/非法 turn items 不伪装成空输出。`input-written` 只证明终端输入写入，必须有 inputReceipt、不得含 turnId 或非空输出，不能解锁结果链。结果传递合同及尚未部署的边界见 [TECH.md](../2026-10-12-plan-result-handoff/TECH.md)。

Controller 使用可跨重启恢复的 PostgreSQL；MemoryStore 仅用于显式测试/开发。凭证通过环境或私有文件提供，不写 CLI 参数、日志或 Git。Gateway 读取现有私有微信账号与独立同步状态，完成 baseline 才可转发新消息；正常重启沿用 checkpoint，不重建基线，不能启动第二个真实 poller。真实轮询、微信发送与部署遵循用户授权；接口返回不证明微信已读或全链路完成。
