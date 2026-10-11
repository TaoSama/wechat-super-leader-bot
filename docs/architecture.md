# Super Leader

项目只有这一套控制平面实现。旧 Python 服务与入口已删除，旧 SQLite 数据仅保留，不作为运行依赖。

下文描述当前本地源码。线上部署与真实验收必须按日期区分，不能由本地测试推断运行服务已更新；准确状态见 [验收清单](changes/2026-10-10-control-plane/ACCEPTANCE.md)。

```text
微信 ── iLink ── Gateway (TypeScript)
                     │ HTTP，消息 ID 去重
                     ▼
Web / API ── Controller (TypeScript) ── PostgreSQL
                     ▲
                     │ Daemon 主动建立 WebSocket；远程必须 TLS
                     │
              demoair Daemon (Go)
                     │ 本机 Unix socket
                     ▼
              已存在的 Codex 会话
```

Controller 是唯一调度入口，Gateway 只转换渠道消息。Daemon 在 demoair 宿主机运行，不在 Docker 内运行，也不启动隔离 worker。Controller 与 PostgreSQL 可以放在 Docker 中；跨机部署不要求 demoair 有公网入站端口。

## 运行边界

- Controller 支持两种入口：未配置模型时使用显式标识的规则模式；配置模型后使用多轮工具调用的 Leader 模式，查询节点/会话/进度、预览固定依赖计划、保存聊天记忆。已有 gpt-6.1-sol Responses、真实 demoair 专用会话和模拟微信的验收证据。远端 Gateway 已有常驻部署记录，但真实微信入站至模型、会话和回复的完整验收仍待用户配合。
- Claude/Grok 原进程适配、旧记忆迁移及持续动态自治尚未实现。技能支持节点目录发现、版本绑定和委托原会话使用，已有一个只读技能的真实会话验收，不代表全部技能均可执行。本地持久调度器支持最多四步固定依赖计划，精确完成才解锁后继；后继正文冻结，不自动传递前项结果或重新规划。
- 当前会话发现包括已加载会话和最近历史记录；只有经实时验证、满足状态要求的会话才允许发送，历史记录不会被自动恢复执行。
- 只支持适配器实际实现和探测到的能力。历史记录可读不代表原会话可控制。
- `accepted` 只表示会话接口接受输入，不能等同于 agent 工作完成。
- 连接中断或发送结果不明时使用 `uncertain`，不自动重发变更指令。
- 目标始终由 `nodeId + sessionId` 标识。自然语言目标不唯一时澄清，不猜测。
- 微信 chatId 必须在允许列表中；扫码取得的账号凭证不能代替操作者授权。
- 控制台 Web 访问采用一次性免密登录，已移除旧版手输 token 登录框，不保留向后兼容：
  - 由用户在微信对话中发送“给我控制台链接”，或由已授权的助手主动发送。
  - 链接带一次性 1 小时有效的 fragment（`#login=<token>`），页面在客户端最早阶段同步清除 URL 中的 hash 与 query，再向后台兑换 `HttpOnly` Cookie。
  - 浏览器登录态固定 1 小时有效，页面刷新可用；Cookie 仅允许明确列出的查询和精确会话发送入口，不具备通用管理写权限。发送入口严格校验同源 Origin、JSON 和专用 intent header，派发前再次验证登录态。
  - 管理 Bearer token 仅供运维或受信节点在服务端环境使用，不下发给浏览器。
  - 链接具备兑换权限，请勿转发他人；微信内置环境打开体验需用户最终确认。
- 凭证不进入 Git，不放进 URL 查询参数，也不显示在日志或命令参数中。
- 已有控制 socket 与桌面原 owner IPC 是独立接入路径。后者依赖客户端内部协议，显式开启且完成完整预检才可发送；无可用 owner 时只读，不更改 App transport、不隐式恢复。版本核验和真实会话联调是上线门槛，当前不具备完整生产保障。

## 会话工作台数据流

会话列表读取原线程的模型、提供方、推理强度、目录、更新时间与加载状态。Daemon 显式遍历 cli/vscode/appServer 的发现分页；不以全局配置推测每个会话的模型。

显式配置 `--codex-home` 可补充只读文件发现，不读取 SQLite、不获得发送能力。桌面观测可提供新鲜的运行状态与模型来源，但不改写 native loaded/status/capabilities。状态通过认证 SSE 更新，断流由轮询兜底；模型来源与发送路线均在界面明确区分。

浏览器通过 `GET /v1/sessions/:nodeId/:sessionId/history` 读取控制接口或原桌面已记录历史。首次请求验证来源，后续刷新和旧页由不透明 historyContext 固定来源；来源失效返回明确错误，不悄悄换路。Controller 的临时 RPC 独立于持久命令，按 socket 实例、节点、会话和 requestId 关联；超时/断连/取消清理，并限制并发与响应大小。历史只投影可展示的用户消息、助手回复与工具结果，不透传内部推理或未知原始对象。前端定期刷新快照、向上滚动加载旧页并保持阅读锚点，不是 token 流式。

浏览器的 `POST /v1/sessions/:nodeId/:sessionId/messages` 固定目标和 send 动作，沿用同一 CommandService、数据库幂等及 Daemon journal。Web 以 commandId/turnId 跟踪回执，accepted 与 completed 分开；不确定请求保留原 requestId，禁止自动重发。界面按会话隔离草稿和历史，退出清理内存，Markdown 禁原始 HTML 和远程图片自动加载。

## Docker 控制平面

### 本机开发启动器

`local.mjs` 生成的开发凭证只保存在忽略入库的 `.runtime/local.json`（0600）；不会覆盖既有配置，不会复制微信 token，不会安装开机自启或修改系统配置。生产部署应接入自己的 secrets 管理。

```sh
pnpm --dir controller install --frozen-lockfile
pnpm --dir web install --frozen-lockfile
pnpm --dir gateway install --frozen-lockfile
pnpm --dir gateway run build
(cd daemon && go build -o bin/super-leader-daemon .)
node local.mjs --init
node local.mjs --up
node local.mjs --daemon
```

最后一条在前台保持 Daemon 运行；在另一个终端运行 `node local.mjs --check` 查看是否接入。Web 地址为 `http://127.0.0.1:8790`。前端无手输 token 界面；本机开发若需签发链接，运行 Controller 时必须显式提供 `CONSOLE_PUBLIC_URL=http://127.0.0.1:8790`（生产环境已显式配置为 `https://leader.example.com`，本机启动器 `local.mjs` 未默认配置该变量），且仅能由模型工具或持有管理 Bearer token 的管理员接口签发。

运行 `node local.mjs --sessions` 可只读列出所有在线节点已发现会话的标题、节点 ID、会话 ID、能力及观察时间，不输出正文或凭证。`canSendNow` 仅表示当前快照中节点在线、会话空闲且支持发送；真正派发时仍会再次校验。选择测试目标请同时提供 `nodeId` 和 `sessionId`，避免同名会话混淆。该命令是本地运维入口，微信端仍使用自然语言，不要求 slash command。

真实微信联调前，先核实实际操作者，再配置对应 Controller 的允许名单。远端部署使用独立 Gateway 容器及显式 `wechat` profile，账号只读挂载、游标独立持久化；操作步骤见 [远端运维说明](runbook/hong-kong.md)。不得通过本地 `--up` 更新远端，不能同时在两台机器轮询同一账号。

首次启用须显式建立消息基线：将启用前积压消息记为跳过并推进游标，不转发、不回复，直到读到空批次。成功后才能开启正常轮询；基线失败时保留进度但不能启动。此操作不是每次启动都运行，更不能用于丢弃已投入使用后的待处理消息。正常重启沿用现有游标和去重状态。

微信 API 地址（账号文件或显式配置）必须使用 HTTPS，不能包含 userinfo、查询参数、片段、控制字符或反斜杠；无效地址在联网前拒绝，不自动降级到 HTTP。区域地址和 HTTPS 路径前缀可用，请求禁止自动跟随重定向。此校验不替代服务端身份与可信域名管理，自定义地址须由操作者确认可信。

停止前台 Daemon/Gateway 使用所在终端的 Ctrl+C；`node local.mjs --down` 只停止本项目 Compose 服务，保留数据库卷和私有凭证。

### 手动注入环境变量

`compose.yaml` 默认仅发布 `127.0.0.1:8790`，不占用旧服务的 8787。远程使用需独立配置 HTTPS/WSS 入口，不要直接将明文端口暴露公网。

在安全的运行环境中提供以下环境变量，或使用不入库、权限为 `0600` 的 env 文件：

- `POSTGRES_PASSWORD`：随机密码；连接串形式要求值可安全用于 URL，建议随机十六进制。
- `CONTROLLER_TOKEN`：随机 HTTP 管理凭证。
- `NODE_TOKENS`：JSON 对象，键是节点 ID，例如 `demoair`，值为该节点独立随机凭证。
- `ALLOWED_CHAT_IDS`：允许操作的微信 chatId，逗号分隔；空值不开放微信控制。

```sh
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:8790/health
```

数据库不向宿主机发布端口。Controller 和数据库分容器，Daemon 不属于 Compose。停止服务用 `docker compose down`，不要加 `-v`，以保留命令记录。

本机如果仅安装独立的 Compose 程序，将以上 `docker compose` 替换为 `docker-compose`；无需修改 Docker 全局配置。

各组件的 CLI、开发命令与配置见各自 README。内存持久化只允许显式测试模式；正式运行必须连接 PostgreSQL。

## 模型驱动的 Super Leader

通过安全环境注入以下配置，再运行 `node local.mjs --up`；启动器会传递环境变量，不会把模型密钥写入本地配置文件。不要把真实密钥写进命令历史或 Git。

| 配置 | 用途 |
| --- | --- |
| `LEADER_MODE=model` | 启用模型工具循环；默认 `rules`，不会暗中调用模型 |
| `LEADER_MODEL_BASE_URL` | 用户选择的 Responses API 基址，包含 `/v1`；远程必须 HTTPS |
| `LEADER_MODEL_NAME` | 服务商提供的模型标识，必须支持工具调用 |
| `LEADER_MODEL_API_KEY` | 模型 API 密钥，独立于 Controller 和微信凭证 |

启用模型意味着当前消息、该聊天最近历史及按需读取的会话元数据/输出会发送给所选模型服务商；先确认数据使用范围。`GET /v1/status` 的 `leaderMode` 区分实际模式。

可直接用自然语言沟通，例如“看看两台机器上的任务分别进行到哪了”“给这两个会话安排独立的检查任务”“记住我希望汇报用中文”。模型可多次查询工具再答复，不需要 slash command。

发送类任务先显示确切机器、会话 ID、完整任务内容、技能版本及依赖；回复“确认执行”或“就按这个执行”才派发，也可取消。待确认计划有效期 10 分钟，新计划替换旧的待确认计划；确认前再次核对目标资格。确认后推进授权最多 24 小时，后继必须等待依赖精确完成和同一发送路线的有效资格。“停止后续任务”不终止已运行任务。计划、聊天历史、记忆与消息回执保存在 PostgreSQL，重复确认不重发；重启只读核查既有回执，不重放结果不明的发送。

每轮最多 6 次模型请求、12 次工具调用、4 个计划步骤；每个任务描述最多 1000 字符。每个聊天最多 8 条显式用户记忆。跨轮查询使用最近历史，长期偏好使用 `remember/recall/forget` 工具，模型不能把工具内容当作用户授权。模型循环超时或故障时明确返回未派发，不改用模糊规则执行。

Web 展示已确认计划的逐步回执与精确会话跳转，确认和取消仍在原微信聊天进行。终态通知由 PostgreSQL 持久化并交独立 Gateway 领取，默认关闭；结果不明不自动重发，接口 accepted 不等于送达。固定依赖调度和终态通知均不能冒充持续动态自治。

## 使用本机技能

本机启动器为 Daemon 配置 `.claude/skills` 和 `.agents/skills`，包含这些安装目录的顶层软链别名；设置 `SKILL_ROOTS` JSON 数组可覆盖，`[]` 可禁用。独立运行 Daemon 则默认不扫描，使用重复的 `--skill-root /absolute/path` 指定。只读检查示例：

```sh
daemon/bin/super-leader-daemon --probe-skills --skill-root /absolute/skills
```

认证后的 `GET /v1/skills` 返回在线节点目录；模型模式可直接问“demoair 有什么技能”“让这个会话按顺序使用设计和 UX 技能优化页面”。Leader 查询 `list_skills`，每个任务最多选 4 个不同技能，在完整预览中按顺序显示名称与 SHA256。确认后 Daemon 一次扫描并验证全部引用，再将有序文件引用和原任务交给已有会话。任一文件变化、引用重复或目录不可验证时整组拒绝，不部分发送或自动降级。顺序属于幂等内容，同请求 ID 换序也拒绝。

完整预览（包括附带链接）超过回复预算时，不保存待确认计划，请用户缩短或分批提出；不能让“确认执行”授权被截断的任务。原会话仍须完整读取全部选定文件并逐份核验 SHA256 后才工作；这不是冻结依赖目录或原子文件事务。本地组合能力的验证与发布边界见 [有序技能组合](changes/2026-10-12-ordered-skills/VERIFICATION.md)。

`list_skills` 支持可选 `query`（1–100 字符），在指定节点范围内对名称/描述做不区分大小写的字面子串搜索，随后按匹配结果分页。用户指定名称时优先搜索，不必在有限模型步骤内扫描所有安装项；找不到时不猜测技能 ID 或路径。

目录仅发现安装包，不把技能包内 references/assets 当成独立安装项；不扫描整个 home，不执行脚本。技能被正确执行与否需原会话输出证据，不能只看 accepted。扫描范围及版本绑定限制见 `docs/changes/2026-10-10-control-plane/SKILLS.md`。

## 验收原则

### 原会话执行状态

发送受理后，Controller 保存对应 `turnId`，经 Daemon 只读查询该轮次的最终状态；重连或重启后只恢复查询，不重发任务。Web 显示关联 turnId，派发截止时间不是任务执行时限。读不到目标轮次时保持 `uncertain`；`completed` 只证明该轮已结束，不替代业务验收。

生产 Daemon 在调用会话前持久化派发 claim，重启不重复执行同一命令；未确认回执落盘并重传，Controller ACK 后仍保留防重记录。本机启动器使用 `.runtime/daemon-state/commands.db`，独立启动可用 `--state-dir` / `DAEMON_STATE_DIR` 指定绝对目录（目录 0700、文件 0600）。不要删除日志来绕过执行状态不明。

底层 turn 已启动、初始响应尚未持久化到 Daemon 时若崩溃，仍需人工核验，不宣称 exactly-once 或无损恢复。详细契约和容量边界见 `docs/changes/2026-10-10-control-plane/TURNS.md`。

单元测试验证协议和故障分支，但不代替真实会话验收。依次验收：

1. PostgreSQL + Controller 启动、鉴权、幂等命令记录。
2. demoair Daemon 注册，读取原有会话元数据和历史。
3. 用户指定可测试会话后，定向发送并核对原会话收到输入。
4. 微信自然语言列表/读取/定向发送；每次下发都能追踪 commandId。

未通过的步骤必须明确标为未验证。不得用新起的 CLI `resume` 会话冒充原有会话接管。

默认统一验证入口：

```sh
node verify.mjs
node verify.mjs --suite unit
node verify.mjs --suite integration
```

完整入口隔离业务环境变量并禁用 dotenv，使用模拟模型、微信、节点，以及仅连接模拟桌面 socket 的真实 Go Daemon；PostgreSQL、HTTP/WS 和组件为真实实现。自建并清理临时容器与进程，包含显式执行的一次性登录测试。直接执行底层脚本不具备全部入口保护，真实只读或发送验收须单独核对授权与目标。命令、环境及 CI 边界见 [可复现验证记录](changes/2026-10-12-reproducible-verification/VERIFICATION.md)。
