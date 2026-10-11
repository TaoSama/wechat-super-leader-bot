# wechat-super-leader-bot

微信 Super Leader Agent：通过微信接收指令，统一管理多台机器上的 Codex 会话、Leader Agent、技能和记忆。

代码仓库：[github.com/TaoSama/wechat-super-leader-bot](https://github.com/TaoSama/wechat-super-leader-bot)（Private）。

## 架构

```text
微信 → Gateway (TypeScript) → Controller / Super Leader (TypeScript)
                                  ├─ Responses API 模型工具循环
会话 Web (React/TypeScript) ────────┤
                                  ├─ PostgreSQL：命令、计划、聊天记忆
                                  └─ WebSocket ← 原生 Daemon (Go，每台宿主机)
                                                     └─ 已运行的 Codex 控制接口
```

Controller 是唯一编排权威。Docker 运行 Controller、Web 和 PostgreSQL；Daemon 在 Mac/Linux 宿主机原生运行，不创建隔离 worker。Gateway 独立运行，不与 Controller 共用微信登录状态。用户仍能查看和操作原会话。

只有一套实现：`controller/`、`daemon/`、`gateway/`、`web/`。旧 Python 应用不再提供入口或兼容层。历史开发记录不代表当前运行能力。

## 香港部署入口

Web：<https://leader.taoai.site>。DNS 直连香港，Controller/Web/PostgreSQL 运行在香港 Docker，宿主机 Daemon 主动通过 WSS 连接，不需要给 Mac 开公网入站端口。

控制台已移除旧版手输 token 登录框，采用微信索取的一次性链接自动登录（无旧版兼容）：
- 用户在微信中发送“给我控制台链接”，或由已授权的助手主动发送。
- 链接带一次性 fragment（如 `https://leader.taoai.site/#login=<token>`），有效期 1 小时，仅可兑换一次。
- 页面加载时立即在前端同步清除地址栏 hash/query，随后向后台兑换 `HttpOnly` Cookie。
- 登录态固定 1 小时，页面刷新可用；Cookie 允许状态/历史查询和精确会话消息发送，不能调用通用管理写接口。管理 Bearer token 仅留作运维与节点使用，不暴露给浏览器。
- 链接凭证持有即可登录，请勿转发他人；微信内置环境打开体验需用户最终确认。

```sh
node local.mjs --check --controller https://leader.taoai.site
node local.mjs --sessions --controller https://leader.taoai.site
~/.local/share/super-leader/bin/super-leader-daemon --service status
```

部署、原生服务及人工微信验收见 [香港运维说明](docs/runbook/hong-kong.md)。已迁移到香港的实例不要再执行本地 `--up` 启动第二个编排权威。

2026-10-12 发布状态：香港运行 `a4ef93c` 镜像，Air 运行 `e1a6408`，已启用文件发现、原桌面 owner 发送和有序技能组合。正式 Cookie 接口此前完成原会话发送、精确 turn 回查、历史分页和重复请求防重发；本轮真实两技能任务完成，并修复握手阶段广播导致首次历史误报过期的问题，正式 HTTP 精确回查同一 assistant 输出、固定上下文分页通过。多会话订阅使用 16 条独立连接共享两个帧处理槽，前轮采样确认 9 个健康 owner 同时可用；30 秒窗口重连仍会短暂重新检查，超过 32 MiB 的会话仍明确不可用。没有改 App transport 或重启 App，不代表所有会话可控或完整生产保障。最新运行情况见 [发布与验收记录](docs/changes/2026-10-12-ordered-skills-release/VERIFICATION.md)，历史文档保留各开发阶段事实。微信真实入站与内置浏览器体验仍待用户确认。

## Web 会话工作台

打开微信中的登录链接后，通过顶部“Super Leader / 会话”切换工作区。Leader 将最近 50 条真实指令分为需要处理、执行中、最近完成，可筛选机器/状态、展开完整回执并返回对应会话。会话列表按机器、标题、目录或模型查找，三行摘要展示标题、状态、预览、模型、项目和时间；提供方、推理强度及完整目录在会话详情中。没有报告的模型明确显示未知，不套用全局默认值。

“Super Leader → 任务计划”显示已确认计划的首步摘要、完成步数和授权时间，展开可看依赖、逐步回执并跳转准确原会话。只把精确完成计入进度；结果存疑、取消后续和授权到期有独立提示，取消不表示原任务已停止。视图沿用状态流实时更新，机器筛选保留完整跨机步骤；最多展示 12 条、进行中优先，不是全部历史。确认和取消仍通过发起计划的微信聊天进行，不增加浏览器管理写权限。已随香港镜像部署；开发期的组件、真实临时 PG/HTTP/SSE 与桌面/手机尺寸验证见 [任务计划视图验收](docs/changes/2026-10-12-plan-console/VERIFICATION.md)，不代替真实微信计划验收。

已接入原桌面模型观测：列表、详情、输入框和搜索优先使用 45 秒内可用的桌面模型设置，模型/提供方/推理强度取自同一来源；过期或失联后显示原控制接口记录，详情注明模型来源及观测时间，没有模型则显示“模型未报告”。Leader 查询使用相同规则。模型展示不改变 loaded 或发送权限。香港与 Air 已更新，开发期真实只读核查及桌面/手机宽度浏览器验证见 [模型观测验收](docs/changes/2026-10-11-desktop-model-observation/VERIFICATION.md)。

会话状态通过认证 SSE 自动更新，断流时单飞轮询兜底；Daemon 每 2 秒检查变化。选中会话的历史每 2 秒读取快照，向上滚动自动加载更早消息，阅读旧消息时新回复不会拉走位置；这是历史快照更新，不是 token 流式。历史最多显示 2000 条，裁剪缺口明确标注，可重新读取最新页；支持安全 Markdown 和折叠工具输出。隐藏页面/会话区及离线时暂停读取，恢复后继续。

已接入原桌面已记录历史：配置 `--desktop-sock` 后，精确 owner 证明决定首次来源；连续刷新和旧页通过不透明 `historyContext` 固定来源，不会在原桌面与控制接口之间偷偷换路。完整加载等待同 owner 的 revision 和完整性证明，不合并尚未记录的 UI 暂态。来源失效时保留已读内容、停止自动请求，并在详情顶部提供“重新读取最新页”。历史连接最多 4 个目标，闲置 60 秒回收；原始帧超过 32 MiB 明确报超限，不返回部分结果冒充完整历史。香港与 Air 已部署并完成真实 Cookie 接口分页回查；开发期证据与限制见 [原桌面历史验收](docs/changes/2026-10-12-desktop-history/VERIFICATION.md)。

状态/模型、控制预检和历史的桌面入站上限统一为 32 MiB，出站仍限 16 MiB；控制读取共享两个连接槽，完整展开前检查深度和节点预算，并拒绝重复历史索引引用。已部署；超过上限的会话仍不可观测或完整读取，不会提高上限掩盖资源问题。帧上限不是内存上限，详见 [大快照资源边界](docs/changes/2026-10-12-desktop-frame-budget/TECH.md) 与 [验收记录](docs/changes/2026-10-12-desktop-frame-budget/VERIFICATION.md)。

Daemon 可显式通过 `--desktop-sock` 订阅既有桌面应用的运行状态。桌面端 `active/idle` 只在观测可用且过去 45 秒内时补足控制接口的 `notLoaded/unknown`；微信查询与 Web 显示使用同一规则，注明来源和观测时间。控制接口的原始状态、loaded 和发送权限保持不变；桌面空闲不等于可以发送。此订阅依赖当前桌面内部协议，不是官方稳定 API；故障或过期会降级，不猜测状态。实现和验收见 [桌面状态观测](docs/changes/2026-10-11-desktop-observation/VERIFICATION.md)。

输入框直接发送到所选原会话，不经过 Leader 再猜目标。控制接口路径要求在线、明确 loaded=true、idle、send 能力和过去 45 秒内的观测；桌面 owner 路径使用独立完整预检产生的 `sendAvailability`，不改写 native loaded/status/capabilities。字段存在但被撤销、非法或过期时，不自动换路；没有可用发送路径时只读，不隐式恢复、不抢占 writer。

原桌面 owner 适配器通过持久 journal 追踪原会话，不更改 App transport、不启动额外后端。Controller/Leader/Web 已接入：新命令服务端选择并持久化路线，确认和派发时复验同一路线，重复 requestId 返回原记录；Web 显示通道和不可用原因，资格过期自动禁用，点击时再检查。Daemon 必须显式启用 `--desktop-send`（要求 `--desktop-sock`），默认仍只读。香港与 Air 已启用，并完成正式 Cookie 接口到专用原会话的真实发送、精确 turn 回查及重复请求防重发。预检仍非原子。开发期证据见 [原 owner 真实发送](docs/changes/2026-10-11-desktop-owner-send/VERIFICATION.md) 与 [跨层路由验证](docs/changes/2026-10-11-desktop-send-route/VERIFICATION.md)。

已修复大量无响应 ID 导致后部桌面会话无法被探测的问题，并提供显式 `--codex-home` 文件发现：只读首条会话元数据、按稳定会话 ID 处理回退后的多份记录，不读取 SQLite 或启动后端。发现、桌面观测、控制权限独立；文件发现不提供历史或发送权限。Air 已启用；Mini 的只读探测在控制 socket 缺失时发现 1 个，但未找到可用桌面 owner，也未安装本项目服务。开发期证据见 [文件发现验证与限制](docs/changes/2026-10-11-rollout-discovery/VERIFICATION.md)。

Mini 最新定点复核：已确认持久化会话 ID，本机 IPC 两次初始化成功，但对该 ID 的 owner discovery 两次超时。这不是整个 Mini 无 owner 的证明；共享控制 socket 缺失也不构成必须重启或改造 App 的理由。未安装正式节点，见 [精确目标复核](docs/changes/2026-10-12-macmini-owner-check/VERIFICATION.md)。

发送后展示受理/完成回执。网络不确定时先使用原请求核查，不能另发一遍；切换会话保留各自的内存草稿，退出登录清除。精确 HTTP 与数据契约见 [会话工作台设计](docs/changes/2026-10-10-control-plane/SESSION_WORKSPACE.md)。前轮部署见 [验证记录](docs/changes/2026-10-10-control-plane/VERIFICATION.md)，本轮增量结果见 [体验与查询修复验收](docs/changes/2026-10-11-workspace-experience/VERIFICATION.md)。

## 独立本机开发环境

需要 Node.js、pnpm、Go、Docker 和 Docker Compose。本地服务启动器仍使用独立 `docker-compose`；验证入口支持 Compose 插件及独立发行版，不自动安装或启动正式服务。

```sh
pnpm --dir controller install --frozen-lockfile
pnpm --dir gateway install --frozen-lockfile
pnpm --dir web install --frozen-lockfile
pnpm --dir gateway run build
cd daemon && go build -o bin/super-leader-daemon . && cd ..
node local.mjs --init
node local.mjs --up
node local.mjs --daemon
```

`--init` 不覆盖现有 `.runtime/local.json`。该文件和 `.runtime/daemon-state/` 是私有运行数据，不提交、不删除；微信账号凭证仍保留在原保存位置。`--daemon` 前台运行，另开终端检查：

```sh
node local.mjs --check
node local.mjs --sessions
```

Web：`http://127.0.0.1:8790`。前端无手输 token 入口；本机若需签发链接，运行 Controller 时必须显式指定 `CONSOLE_PUBLIC_URL=http://127.0.0.1:8790`（生产环境已显式配置为 `https://leader.taoai.site`，本机启动器 `local.mjs` 未默认配置该变量），且仅能由模型工具或持有管理 Bearer token 的管理员接口签发。

## 模型与自然语言

模型直接使用 Responses API，不维护 Chat Completions 兼容层。启动 Controller 前，通过进程环境提供：

| 变量 | 内容 |
| --- | --- |
| `LEADER_MODE` | `model` |
| `LEADER_MODEL_BASE_URL` | Codex 当前 provider 的 API 基址，包含 `/v1` |
| `LEADER_MODEL_NAME` | `gpt-6.1-sol` |
| `LEADER_MODEL_API_KEY` | 当前 provider 的授权 API key，不写入命令历史或仓库 |

容器需要现有代理出网时，显式设置 `CONTROLLER_HTTPS_PROXY`。本机 Colima 的宿主机代理已验证为 `http://192.168.5.2:7890`；这不是其他机器的通用地址，不自动修改系统代理或 DNS。

模拟联调可在 `--up` 后加 `--simulation-chat synthetic-live-test`，仅该次部署开放模拟 chatId，不修改私有允许名单、不启动微信。结束后不带此参数重新部署即可关闭。

未配置模型时的 `rules` 仅用于诊断，不是自然语言 Leader 的完整能力。真实模型会收到当前聊天消息、必要历史及查询的会话资料。

例如：“看看 Mac Air 上这个会话的进度”“让这个会话只回复测试字符串”。发送任务先生成准确目标和内容的计划；回复“确认执行”才发送，待确认阶段说“取消计划”不会派发。`accepted` 只表示受理；必须跟踪关联 `turnId` 的终态和输出才算测试成功。

已支持最多四步的持久依赖计划，例如“先让这个会话检查测试，完成后再让另一个会话检查文档”。预览冻结每步的目标、内容、技能版本和依赖，10 分钟内确认后最多自动推进 24 小时；只有精确完成回执才解锁后继，同一会话还要等待空闲资格。可说“计划到哪了”查询，或“停止后续任务”取消；取消不终止原会话已运行的任务，已领取项可能已发送。结果不明时不重发；重启后查原回执，不另起后端。后续内容不会自动吸收前项输出，需动态决定时应查询结果后另提计划。已随香港镜像部署；原子确认、取消、真实临时 PG 和 HTTP/WS 开发期验收见 [持久计划验证](docs/changes/2026-10-12-persistent-plans/VERIFICATION.md)，真实微信计划仍待验收。

已部署每任务最多 4 个有序技能组合，例如“按顺序使用设计和 UX 技能优化页面”。预览列出全部技能及 SHA256，确认与派发均核对整组；任一失配不部分执行，同请求调换顺序也拒绝。预览过长时不保存可确认计划，避免授权未显示的内容。正式原会话已验证两技能按指定顺序完整读取与实算 SHA256、精确 turn 完成、相同请求不重发及反序 HTTP 409；这是管理接口验收，不代替微信自然语言实测，也不冻结技能依赖目录。见 [开发合同](docs/changes/2026-10-12-ordered-skills/VERIFICATION.md) 与 [正式发布验收](docs/changes/2026-10-12-ordered-skills-release/VERIFICATION.md)。

已确认计划可生成终态微信通知：完成、失败或授权到期后，在原聊天提示计划 ID、总步数和状态，不包含任务正文、会话输出或登录链接。默认关闭，需 Gateway 显式开启 `GATEWAY_PLAN_NOTIFICATIONS=true`（或 `--plan-notifications`）；只在既有基线和聊天 context 可用时处理。通知与计划终态同事务保存，每条只领取一次；结果不明不自动重发，`accepted` 仅表示微信接口受理，不保证送达或已读。代码已随香港镜像部署，但通知开关未启用，未做真实外发验收，不等于持续动态自治已经完成。真实临时 PostgreSQL/Controller/Gateway 与模拟微信验收见 [计划通知验证](docs/changes/2026-10-12-plan-notifications/VERIFICATION.md)。

## 微信实测边界

香港使用独立 Gateway Docker 服务，只有显式选择 `wechat` profile 才启动；不操作用户微信客户端。Controller 的 `ALLOWED_CHAT_IDS` 只允许已核实的操作者，账号登录 token 不等于操作者授权。

首次上线必须先执行 `--establish-baseline`：读取至原始空消息页，只保存上下文、去重记录和 cursor，**不转发历史消息、不回复历史消息**。没有完成基线时，`--run` 与 `--poll-once` 会拒绝执行；正常重启沿用状态，不能再次建基线丢弃积压消息。

部署入口见 [Gateway 说明](gateway/README.md) 与 [香港运维说明](docs/runbook/hong-kong.md)。同一账号只能在一个位置轮询；香港启用后不要在 Mac 再运行 `node local.mjs --gateway`，本机允许名单维持为空。不要用本地 `--up` 更新香港。

健康检查仅确认本次 Gateway 进程近期成功完成轮询；空轮询不证明模型或会话控制可用。香港 Controller 与 Gateway 已完成构建与启动（沿用既有 PostgreSQL 卷，服务均为 healthy，Gateway `last_poll_succeeded_at` 为 2026-10-11T09:05:17.641Z 且 errors 为 0，已加载本人 allowlist）。服务端已使用本人 chatId 模拟文本“给我控制台链接”，真实 `gpt-6.1-sol`（12093ms）返回可用免密链接，经兑换（200）与退出（200）验证，未外发微信消息；真实浏览器初次自动登录后 URL 仅保留 `https://leader.taoai.site/`，无 token 输入框，本地 storage 为 0，HttpOnly Cookie 不可脚本读取，刷新 session（200）正常展示 macair 节点。目前仍待用户微信实际入站与内置浏览器点击确认，不能提前宣称全链路最终验收。

## 验证与限制

先按三个组件的锁文件安装依赖。统一入口要求 Node.js >=24、pnpm 11.8.0 和 `daemon/go.mod` 指定的 Go；完整验证还需要本地 Unix socket Docker 和 Compose，以及 `postgres:16-alpine` 镜像。依赖与镜像下载不是离线测试的一部分。

```sh
node verify.mjs                     # 全部组件、构建、Go race/vet、真实临时 PG 整链与登录
node verify.mjs --suite unit        # 不需要 Docker
node verify.mjs --suite integration # 构建后运行临时 PG 与 Compose 配置验证
node verify.mjs --list              # 只列计划，不运行检查
```

入口从脚本位置定位项目目录，不依赖调用目录；剔除真实业务环境变量和 LIVE 测试开关，显式关闭 Controller/Vitest/Vite 的 dotenv 文件加载，Compose 配置检查只用合成环境。完整验证固定到本地 Docker Unix socket，拒绝 TCP/SSH 远端 engine。模型、微信和桌面 owner 均用合成目标，不连接真实会话或正式数据库；这不是操作系统沙箱，依赖工具仍使用现有工具链与缓存。

`test-console-auth.mjs` 默认只显示帮助，统一入口明确带 `--run`，验证真实临时 PostgreSQL 中的一次性兑换、1 小时到期、Cookie、并发和重启。收到 SIGINT/SIGTERM 后，入口等待当前检查正常收尾，再停止后续步骤；异常断连不会因重复等待 WebSocket close 而跳过其他资源清理。强制终止、掉电及未响应退出的子进程不在此保证内。

仓库新增 `.github/workflows/verify.yml`：Ubuntu 运行完整验证，macOS 运行不依赖 Docker 的单测与构建，CI 使用 Node 24。当前本机实际为 Node 26；工作流配置检查不等于 GitHub 已运行，未推送前不宣称 CI 通过。实现、命令和交付边界见 [可复现验证](docs/changes/2026-10-12-reproducible-verification/TECH.md)。

已有终端 Agent 支持显式只读观测：Daemon 配置 `--terminal-sock <已有绝对路径>` 与可重复 `--terminal-pane <明确wN:pN>` 后，每 15 秒独立刷新状态；Web 标注终端来源，状态超过 45 秒失效，不轮询聊天历史、默认不开放发送。微信可明确询问该会话的最新输出，获得有裁剪提示的有限终端快照；不等于完整历史或精确任务回执。`--probe` 可无 token 检查该来源，不写 journal，不启动终端宿主。当前只接受已核对的 protocol 22，默认关闭，macOS/Linux 用户服务可保存相同参数。观测代码已随构建产物部署，但未配置真实终端目标、未启用观测，见 [终端观测设计与边界](docs/changes/2026-10-12-terminal-observation/TECH.md)。

原终端单步输入现已接通源码中的持久命令、Controller、Web 与自然语言确认链路，**尚未部署或启用正式终端发送**。必须在已有 socket 和明确 pane 清单之外显式设置 `--terminal-send-mode=non-atomic`，并使用真实持久 journal；独立零输入预检通过后才发布 45 秒发送资格。不启动 Agent、不恢复会话、不使用默认焦点，也不在通道失效时自动换路。同一 PTY 内原 CLI 退出、替换和人工输入的非原子窗口仍存在，启用前必须接受此边界并验收明确目标。

Web 可向明确终端会话发送单步输入；微信模型模式先生成带非原子警告的准确目标/内容预览，用户确认后才投递。规则诊断模式仍只读，所有含终端的多步和持久依赖计划均拒绝。回执 `input-written` 只显示“输入已写入，执行未确认”，独立于最近完成；六字段输入证明不包含私有 socket、原会话路径或虚构 turn/output。命令先持久化身份再写入，重复请求与重启不重发；丢回执保持 `uncertain`，仅核查原请求，不能凭 idle/done 解锁后继。

公开包运行示例仍仅连接自建临时 socket，可在 `daemon/` 执行 `go run -race ./examples/terminal-delivery --run`。完整合成链和 Web 验收入口、边界见 [终端控制合同](docs/changes/2026-10-12-terminal-control-chain/TECH.md) 与 [验证记录](docs/changes/2026-10-12-terminal-control-chain/VERIFICATION.md)；这不代替真实 CLI、真实模型或微信验收。

现阶段重点验收香港 Controller 与 Mac Air 的 Codex 会话。独立 CLI 的真实发送验收与精确完成回执、所有会话附着和持续自治调度尚未完成；合成终端投递、单节点部署与联调不代表完整生产保障。准确证据见 `docs/changes/2026-10-10-control-plane/ACCEPTANCE.md` 与 `VERIFICATION.md`。
