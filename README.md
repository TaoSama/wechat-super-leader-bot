# wechat-super-leader-bot

微信 Super Leader Agent：通过微信接收指令，统一管理多台机器上的 Codex 会话、Leader Agent、技能和记忆。

代码仓库：[github.com/TaoSama/wechat-super-leader-bot](https://github.com/TaoSama/wechat-super-leader-bot)（Private）。

## 架构

```text
微信 → Gateway (TypeScript) → Controller / Super Leader (TypeScript)
                                  ├─ Responses API 模型工具循环
会话 Web (React/TypeScript) ────────┤
                                  ├─ PostgreSQL：命令、计划、持续目标、聊天记忆
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

2026-10-13 发布基线：香港 Controller/Web 与 Air Daemon 为 `08e260a`，Gateway 保持 `3a750e7`，Mini Daemon 保持 `ef32a2f`。紧凑筛选与显式分页历史已上线，正式 HTTPS 浏览器和两个 Air 长会话读取通过；详见 [大历史发布验收](docs/changes/2026-10-13-history-source/VERIFICATION.md)。持续目标代码同步上线，但本轮专用会话发送资格不可用，真实持续闭环尚未验收，见 [持续目标验收记录](docs/changes/2026-10-13-continuous-goals/VERIFICATION.md)。不改 App transport、不启动额外后端。

真实 `gpt-6.1-sol` 已返回专用原会话的近期记录、实际来源和本次获取时间；无新增命令或计划，重复查询及 Controller 换版后重放的业务摘要均不变，验收会话已重新归档。曾发生两次模型服务临时失败，第三次查询通过，失败证据保留。详见 [自然语言历史查询验收](docs/changes/2026-10-12-leader-session-history/VERIFICATION.md) 与 [快照并发修复](docs/changes/2026-10-13-node-session-persistence.md)。该历史查询仍是服务端模拟微信入站；本次真实微信索取控制台链接及兑换已核实，内置浏览器体验和真实微信会话控制仍待验收。

此前 Air 原桌面 owner 路由的真实模型两步结果接力、精确 turn/输出回查与重复确认防重发已通过；正式浏览器连续 242 秒 / 97 次读取、旧消息位置保留及直接发送的证据见 [此前发布验收](docs/changes/2026-10-12-authorized-release/VERIFICATION.md)。多会话订阅仍使用 16 条独立连接共享两个帧处理槽，30 秒窗口重连会短暂重新检查，超过 32 MiB 的桌面帧明确拒绝；下述分页历史只提供替代读取，不恢复桌面观测或发送资格。短时验证不等于长期负载保障。旧页面应刷新以加载同版数据合同。

## Web 会话工作台

打开微信中的登录链接后，通过顶部“Super Leader / 会话”切换工作区。Leader 将最近 50 条真实指令分为需要处理、执行中、最近完成，可筛选机器/状态、展开完整回执并返回对应会话。会话列表按机器、标题、目录或模型查找，三行摘要展示标题、状态、预览、模型、项目和时间；提供方、推理强度及完整目录在会话详情中。没有报告的模型明确显示未知，不套用全局默认值。

“Super Leader → 任务计划”显示已确认计划的首步摘要、完成步数和授权时间，展开可看依赖、逐步回执并跳转准确原会话。只把精确完成计入进度；结果存疑、取消后续和授权到期有独立提示，取消不表示原任务已停止。视图沿用状态流实时更新，机器筛选保留完整跨机步骤；最多展示 12 条、进行中优先，不是全部历史。确认和取消仍通过发起计划的微信聊天进行，不增加浏览器管理写权限。已随香港镜像部署；开发期的组件、真实临时 PG/HTTP/SSE 与桌面/手机尺寸验证见 [任务计划视图验收](docs/changes/2026-10-12-plan-console/VERIFICATION.md)，不代替真实微信计划验收。

已接入原桌面模型观测：列表、详情、输入框和搜索优先使用 45 秒内可用的桌面模型设置，模型/提供方/推理强度取自同一来源；过期或失联后显示原控制接口记录，详情注明模型来源及观测时间，没有模型则显示“模型未报告”。Leader 查询使用相同规则。模型展示不改变 loaded 或发送权限。香港与 Air 已更新，开发期真实只读核查及桌面/手机宽度浏览器验证见 [模型观测验收](docs/changes/2026-10-11-desktop-model-observation/VERIFICATION.md)。

会话状态通过认证 SSE 自动更新，断流时单飞轮询兜底；Daemon 每 2 秒检查变化。选中会话的历史每 2 秒读取快照，向上滚动自动加载更早消息，阅读旧消息时新回复不会拉走位置；这是历史快照更新，不是 token 流式。历史最多显示 2000 条，裁剪缺口明确标注，可重新读取最新页；支持安全 Markdown 和折叠工具输出。隐藏页面/会话区及离线时暂停读取，恢复后继续。

已接入原桌面已记录历史：配置 `--desktop-sock` 后，精确 owner 证明决定首次来源；连续刷新和旧页通过不透明 `historyContext` 固定来源，不会在原桌面与控制接口之间偷偷换路。完整加载等待同 owner 的 revision 和完整性证明，不合并尚未记录的 UI 暂态。来源失效时保留已读内容、停止自动请求，并在详情顶部提供“重新读取最新页”。历史连接最多 4 个目标，闲置 60 秒回收；原始帧超过 32 MiB 明确报超限，不返回部分结果冒充完整历史。香港与 Air 已部署并完成真实 Cookie 接口分页回查；开发期证据与限制见 [原桌面历史验收](docs/changes/2026-10-12-desktop-history/VERIFICATION.md)。

状态/模型、控制预检和历史的桌面入站上限统一为 32 MiB，出站仍限 16 MiB；控制读取共享两个连接槽，完整展开前检查深度和节点预算，并拒绝重复历史索引引用。已部署；超过上限仍不能通过桌面全量帧观测或读取，分页读取另需既有控制 socket，不会提高上限掩盖资源问题。帧上限不是内存上限，详见 [大快照资源边界](docs/changes/2026-10-12-desktop-frame-budget/TECH.md) 与 [验收记录](docs/changes/2026-10-12-desktop-frame-budget/VERIFICATION.md)。

长会话读取失败时，Web 提供“使用分页历史接口”，显式改读同一会话在既有控制 socket 中保存的分页记录；可能稍有延迟，不改变发送通道。换源会清空旧阅读窗口并建立新 context，不静默混合记录；413 后暂停自动重试，仍可手动读取。该接口单帧仍限 8 MiB，没有控制 socket 的机器不能使用；Mini 目前仍走原桌面历史。机器/状态筛选同时收紧为桌面 32px、触控 44px。代码和正式发布状态见 [大历史修复记录](docs/changes/2026-10-13-history-source/VERIFICATION.md)。

Daemon 可显式通过 `--desktop-sock` 订阅既有桌面应用的运行状态。桌面端 `active/idle` 只在观测可用且过去 45 秒内时补足控制接口的 `notLoaded/unknown`；微信查询与 Web 显示使用同一规则，注明来源和观测时间。控制接口的原始状态、loaded 和发送权限保持不变；桌面空闲不等于可以发送。此订阅依赖当前桌面内部协议，不是官方稳定 API；故障或过期会降级，不猜测状态。实现和验收见 [桌面状态观测](docs/changes/2026-10-11-desktop-observation/VERIFICATION.md)。

输入框直接发送到所选原会话，不经过 Leader 再猜目标。控制接口路径要求在线、明确 loaded=true、idle、send 能力和过去 45 秒内的观测；桌面 owner 路径使用独立完整预检产生的 `sendAvailability`，不改写 native loaded/status/capabilities。字段存在但被撤销、非法或过期时，不自动换路；没有可用发送路径时只读，不隐式恢复、不抢占 writer。

原桌面 owner 适配器通过持久 journal 追踪原会话，不更改 App transport、不启动额外后端。Controller/Leader/Web 已接入：新命令服务端选择并持久化路线，确认和派发时复验同一路线，重复 requestId 返回原记录；Web 显示通道和不可用原因，资格过期自动禁用，点击时再检查。Daemon 必须显式启用 `--desktop-send`（要求 `--desktop-sock`），默认仍只读。香港与 Air 已启用，并完成正式 Cookie 接口到专用原会话的真实发送、精确 turn 回查及重复请求防重发。预检仍非原子。开发期证据见 [原 owner 真实发送](docs/changes/2026-10-11-desktop-owner-send/VERIFICATION.md) 与 [跨层路由验证](docs/changes/2026-10-11-desktop-send-route/VERIFICATION.md)。

已修复大量无响应 ID 导致后部桌面会话无法被探测的问题，并提供显式 `--codex-home` 文件发现：只读首条会话元数据、按稳定会话 ID 处理回退后的多份记录，不读取 SQLite 或启动后端。发现、桌面观测、控制权限独立；文件发现不提供历史或发送权限。Air 与 Mini 均已启用，Mini 控制 socket 缺失时仍发现 1 个持久会话。开发期证据见 [文件发现验证与限制](docs/changes/2026-10-11-rollout-discovery/VERIFICATION.md)。

Mini 最新定点复核：通过已运行 App 的正常精确会话导航恢复原 owner，未改连接方式、重启 App 或新建会话；正式历史连续读取、旧页和独立只读探针通过。LaunchAgent 已更新为同版 `ef32a2f`，显式启用 `--desktop-send`；正式状态报告有效的 `desktop-owner/ready` 资格。此前的 `no-client-found` 已被现场证据解释为当时该会话未加载，不能据此要求更换后端。Mini 真实发送仍未验收，详见 [最新节点与 owner 证据](docs/changes/2026-10-13-macmini-owner-activation.md)。

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

自然语言明确查询具体会话输出时，`read_session` 复用 Web 的原来源历史通道，不再创建持久读取命令，也不会仅返回文件元数据。返回最近最多 8 条已记录内容，每条正文最多 1000 Unicode 码点且 JSON 编码最多 3000 字符，总结果 JSON 最多 11000 字符；超限优先保留较新记录，并注明来源、获取时间、更早内容及裁剪。它不是完整历史、未记录的实时输出或本次任务完成证明；只问正在运行的任务列表时不读正文。终端必须已显式配置并报告 `historySource=terminal-transcript`，否则说明不可读，不改读终端屏幕。设计及验收门槛见 [自然语言历史查询](docs/changes/2026-10-12-leader-session-history/TECH.md)；正式发布状态以该目录验收记录为准。

已支持最多四步的持久依赖计划，例如“先让这个会话检查测试，完成后再让另一个会话检查文档”。预览冻结每步的目标、内容、技能版本和依赖，10 分钟内确认后最多自动推进 24 小时；只有精确完成回执才解锁后继，同一会话还要等待空闲资格。可说“计划到哪了”查询，或“停止后续任务”取消；取消不终止原会话已运行的任务，已领取项可能已发送。结果不明时不重发；重启后查原回执，不另起后端。后续内容不会自动吸收前项输出，需动态决定时应查询结果后另提计划。已随香港镜像部署；原子确认、取消、真实临时 PG 和 HTTP/WS 开发期验收见 [持久计划验证](docs/changes/2026-10-12-persistent-plans/VERIFICATION.md)，真实微信计划仍待验收。

已部署已确认计划的结果传递，并完成同一真实 Air 会话的两步模型接力与原生回执交叉核对；不同物理机接力仍待验收。例如“让 Air 的这个会话检查问题，再把它的结果交给另一个会话复核”：预览须明确后继的结果来源，确认后才将同计划所选前驱的精确完成回执作为资料附在原任务后；普通依赖默认不共享输出。每来源最多 1000 Unicode 码点且 JSON 编码含转义最多 3000 字符，裁剪、来源命令/turn、全文记录 SHA256 与实际请求文本一并持久保存。已记录输出为空会明确标示，缺失输出则停止，不冒充空结果；重启不重新采样或重发已领取步骤。Web 计划和微信状态查询显示来源、冻结与裁剪状态，不把冻结当作送达，也不在计划摘要中展示结果正文；认证命令详情仍如实显示已记录的实际请求（含附件），记录不证明已发送。只支持精确完成的原生会话步骤，终端 `input-written` 不参与；仍不动态改写任务、增加目标或重规划。详细边界见 [结果传递合同](docs/changes/2026-10-12-plan-result-handoff/TECH.md) 与 [正式验收记录](docs/changes/2026-10-12-authorized-release/VERIFICATION.md)。

已部署每任务最多 4 个有序技能组合，例如“按顺序使用设计和 UX 技能优化页面”。预览列出全部技能及 SHA256，确认与派发均核对整组；任一失配不部分执行，同请求调换顺序也拒绝。预览过长时不保存可确认计划，避免授权未显示的内容。正式原会话已验证两技能按指定顺序完整读取与实算 SHA256、精确 turn 完成、相同请求不重发及反序 HTTP 409；这是管理接口验收，不代替微信自然语言实测，也不冻结技能依赖目录。见 [开发合同](docs/changes/2026-10-12-ordered-skills/VERIFICATION.md) 与 [正式发布验收](docs/changes/2026-10-12-ordered-skills-release/VERIFICATION.md)。

已确认固定计划可生成终态微信通知：完成、失败或授权到期后，在原聊天提示计划 ID、总步数和状态，不包含任务正文、会话输出或登录链接。Gateway 默认关闭，香港已显式开启 `GATEWAY_PLAN_NOTIFICATIONS=true`；只在既有基线和聊天 context 可用时处理。通知与计划终态同事务保存，每条只领取一次；结果不明不自动重发，`accepted` 仅表示微信接口受理，不保证送达或已读。正式唯一通知目前为 `uncertain`，没有补发、删除或重建基线；后续失败会记录脱敏错误分类。真实过程见 [通知启用与未知回执](docs/changes/2026-10-13-wechat-notification-activation.md)，合成整链见 [计划通知验证](docs/changes/2026-10-12-plan-notifications/VERIFICATION.md)。

## 持续目标：依据结果决定下一步

与预先写死的四步计划分开，持续目标允许 Super Leader 在授权范围内读取精确任务结果，再决定下一步任务或判断条件是否满足。模型只提出决策；Controller 负责资格检查、持久化、预算、派发和防重发。

自然语言示例：“在 Air 的验收会话中持续检查这个问题，根据结果安排下一步；完成条件是得到测试结果及复核结论。只读、不改文件，最多派发 3 次、判断 5 次，30 分钟内结束。”系统先展示精确会话、条件、技能、限制、结果共享范围与实际预算；确认无误后回复预览中的 `确认目标 <目标ID>`，才开始后台推进。没有 slash command，不需要每一步再发消息。

可说“目标进展怎么样”查询，或“取消目标”停止后继；取消不会终止原会话已运行的任务。结果不明、任务失败、证据不足或预算耗尽时停止并保留记录，不换请求重发。每个聊天同时只允许一个未结束的目标或固定计划；需要处理的目标须取消或到期后才释放授权位置。

Web 的“持续目标”卡实时显示状态、预算、逐项条件和动作，展开后可跳到准确原会话。完成显示“模型判断条件已满足”，不把模型结论当作独立业务验收；证据缺失或矛盾显示待核查。当前持续目标终态**尚无主动微信通知**，通过查询或 Web 查看；固定计划通知不能代替它。仅精确原生完成回执可参与闭环，CLI 的 `input-written` 不可参与。完整边界、开发验证与部署状态见 [持续目标合同](docs/changes/2026-10-13-continuous-goals/TECH.md) 和 [验收记录](docs/changes/2026-10-13-continuous-goals/VERIFICATION.md)。

## 微信实测边界

香港使用独立 Gateway Docker 服务，只有显式选择 `wechat` profile 才启动；不操作用户微信客户端。Controller 的 `ALLOWED_CHAT_IDS` 只允许已核实的操作者，账号登录 token 不等于操作者授权。

首次上线必须先执行 `--establish-baseline`：读取至原始空消息页，只保存上下文、去重记录和 cursor，**不转发历史消息、不回复历史消息**。没有完成基线时，`--run` 与 `--poll-once` 会拒绝执行；正常重启沿用状态，不能再次建基线丢弃积压消息。

部署入口见 [Gateway 说明](gateway/README.md) 与 [香港运维说明](docs/runbook/hong-kong.md)。同一账号只能在一个位置轮询；香港启用后不要在 Mac 再运行 `node local.mjs --gateway`，本机允许名单维持为空。不要用本地 `--up` 更新香港。

健康检查仅确认本次 Gateway 进程近期成功完成轮询；空轮询不证明模型或会话控制可用。香港沿用既有 PostgreSQL 卷和 Gateway 状态，2026-10-13 本轮发布后三服务均为 healthy。此前服务端使用本人 chatId 模拟文本“给我控制台链接”，真实 `gpt-6.1-sol`（12093ms）返回可用免密链接，经兑换（200）与退出（200）验证，未外发该模拟请求的微信消息；浏览器自动登录后 URL 仅保留 `https://leader.taoai.site/`，无 token 输入框，本地 storage 为 0，HttpOnly Cookie 不可脚本读取，刷新 session（200）正常展示 macair 节点。该模拟与下面的真实微信请求分开记录。

2026-10-13 补充真实证据：用户本次微信索取控制台链接，正式入站记录与准确回复链接的兑换记录已关联，确认请求、回复及兑换成功。未补发消息，未输出凭证；服务器记录不能识别是否使用微信内置浏览器。详见 [本轮核验](docs/changes/2026-10-13-history-source/VERIFICATION.md)。

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

仓库 `.github/workflows/verify.yml`：Ubuntu 运行完整验证，macOS 运行不依赖 Docker 的单测与构建，CI 使用 Node 24。当前本机实际为 Node 26；已部署产品提交 `08e260a` 的 GitHub run [38295230409](https://github.com/TaoSama/wechat-super-leader-bot/actions/runs/38295230409) 已通过 Ubuntu 全量 / macOS unit。早期发布失败及修复保留在 [此前发布证据](docs/changes/2026-10-12-authorized-release/VERIFICATION.md)。实现、命令和交付边界见 [可复现验证](docs/changes/2026-10-12-reproducible-verification/TECH.md)。

已有终端 Agent 支持显式只读观测：Daemon 配置 `--terminal-sock <已有绝对路径>` 与可重复 `--terminal-pane <明确wN:pN>` 后，每 15 秒独立刷新状态；Web 标注终端来源，状态超过 45 秒失效，默认不读取聊天历史、不开放发送。显式管理诊断命令仍可读取有裁剪提示的有限终端快照；模型的 `read_session` 改用下述显式启用的已记录历史，不暗中改读屏幕，也不作为精确任务回执。`--probe` 可无 token 检查该来源，不写 journal，不启动终端宿主。当前只接受已核对的 protocol 22，默认关闭，macOS/Linux 用户服务可保存相同参数。观测代码已随构建产物部署，但未配置真实终端目标、未启用观测，见 [终端观测设计与边界](docs/changes/2026-10-12-terminal-observation/TECH.md)。

原 CLI 历史读取代码已随候选部署，**未启用或配置真实记录目录**。除已有 socket 和明确 pane 外，须逐个提供方显式增加 `--terminal-history-root codex=/absolute/sessions`、`--terminal-history-root claude=/absolute/projects` 或 `--terminal-history-root grok=/absolute/sessions`；路径指向记录目录本身，每提供方最多一个。不会从 home、环境变量或只授权元数据发现的 `--codex-home` 推导正文权限。仅可信会话 ID 绑定可用，配置目录不等于保证文件存在。

启用后 Web 显示“CLI 会话记录”，沿用 2 秒快照刷新与向上自动分页；读取原 JSONL 中的用户/助手可见文本，隐藏推理和私有元数据。Grok ACP 文本明确标注“文本片段（非完整轮次）”，不伪造消息结束、turn ID 或完成回执。旧页不因追加漂移，文件改写/替换或原会话换绑使上下文失效，必须显式重新读取；来源撤销或观测过期会暂停并保留已读内容。每文件最多 32 MiB，读取预算和不支持格式见 [历史读取合同](docs/changes/2026-10-12-terminal-history/TECH.md)。真实 Go/HTTP/临时 PG 与独立浏览器合成验收均通过，证据见 [验证记录](docs/changes/2026-10-12-terminal-history/VERIFICATION.md)；不代表真实 CLI、微信或 Linux 服务已验收。

原终端单步输入现已接通持久命令、Controller、Web 与自然语言确认链路，代码已部署，**尚未启用正式终端发送**。必须在已有 socket 和明确 pane 清单之外显式设置 `--terminal-send-mode=non-atomic`，并使用真实持久 journal；独立零输入预检通过后才发布 45 秒发送资格。不启动 Agent、不恢复会话、不使用默认焦点，也不在通道失效时自动换路。同一 PTY 内原 CLI 退出、替换和人工输入的非原子窗口仍存在，启用前必须接受此边界并验收明确目标。

Web 可向明确终端会话发送单步输入；微信模型模式先生成带非原子警告的准确目标/内容预览，用户确认后才投递。规则诊断模式仍只读，所有含终端的多步和持久依赖计划均拒绝。回执 `input-written` 只显示“输入已写入，执行未确认”，独立于最近完成；六字段输入证明不包含私有 socket、原会话路径或虚构 turn/output。命令先持久化身份再写入，重复请求与重启不重发；丢回执保持 `uncertain`，仅核查原请求，不能凭 idle/done 解锁后继。

公开包运行示例仍仅连接自建临时 socket，可在 `daemon/` 执行 `go run -race ./examples/terminal-delivery --run`。完整合成链和 Web 验收入口、边界见 [终端控制合同](docs/changes/2026-10-12-terminal-control-chain/TECH.md) 与 [验证记录](docs/changes/2026-10-12-terminal-control-chain/VERIFICATION.md)；这不代替真实 CLI、真实模型或微信验收。

现阶段重点验收香港 Controller 与 Mac Air 的 Codex 会话。结果驱动持续目标已有独立持久调度器，交付范围以增量验收记录为准；真实持续目标闭环、持续目标主动通知、微信会话控制、跨物理机闭环、公司机器及独立 CLI 的真实发送和精确完成回执仍未全部验收。真实微信索取登录链接已单独核实，不能推导其他能力可用，也不能把合成终端投递或单节点联调称为所有 Agent 的完整生产保障。历史能力矩阵见 `docs/changes/2026-10-10-control-plane/ACCEPTANCE.md` 与 `VERIFICATION.md`。
