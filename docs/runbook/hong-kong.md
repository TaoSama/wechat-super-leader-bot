# 香港控制平面

## 拓扑与访问边界

```text
Web 浏览器 ── HTTPS ── 香港 Nginx ── 127.0.0.1:8790 Controller + Web
                                                    │
                                                    └─ Docker 私网 PostgreSQL
Mac / Linux 原生 Daemon ── 主动 WSS ───────────────────┘
          └─ 本机已有 Codex 控制 socket（不另起 app-server）
```

- 入口：`https://leader.taoai.site`，A 记录直接解析香港 VPS，关闭 CDN 代理。
- 香港安装目录：`/opt/super-leader`。已有其他应用的 Nginx 站点、容器及端口不变。
- Controller 不直接发布公网端口，数据库不发布宿主端口。TLS 使用自动续期证书，HTTP 仅处理 ACME 验证与 HTTPS 重定向。
- 控制台 Web 为会话工作台，已移除旧版手输 token 登录框，不保留向后兼容：
  - 访问入口由用户在微信对话中发送“给我控制台链接”，或由已授权的助手主动发送。
  - 链接格式为 `https://leader.taoai.site/#login=<token>`，带 1 小时有效的一次性 fragment。
  - 页面加载时在前端同步清除地址栏的 hash 与 search，再通过 `POST /auth/exchange` 向后端兑换 `HttpOnly` Cookie。
  - 登录态固定 1 小时有效，页面刷新可用；Cookie 允许状态、历史查询及精确会话的消息发送。消息写入要求精确同源 Origin、JSON、专用 intent header，派发前再次校验登录态；通用命令、微信消息和签发链接的管理写接口仍不接受 Cookie。
  - 1Password `DEV-CREDENTIALS` 保险库中 `Super Leader HK` 的 Controller Bearer token 仅作为运维和管理接口凭据保留在服务端环境，不下发给浏览器。
  - 链接具备兑换权限，请勿转发他人；微信内点击打开的完整体验需由用户在微信端最终验证。
- 本地项目目录：`~/Workspaces/wechat-super-leader-bot`。原始 Codex 会话不会因移动项目自动变更其工作目录，不应隐式恢复或重建会话。

验收优先复用本项目专用测试会话，不向工作会话发送探测消息；用完归档，可在后续确需测试时明确恢复该测试会话。测试浏览器页面和临时服务应关闭，正式 Controller、Gateway、Daemon 和运行数据保留。

## 香港运维

SSH 登录对应香港 VPS 后：

```sh
cd /opt/super-leader
docker compose --env-file .runtime/controller.env \
  -f compose.yaml -f deploy/compose.production.yaml ps
docker compose --env-file .runtime/controller.env \
  -f compose.yaml -f deploy/compose.production.yaml logs --tail 80 controller
```

生产机不承担镜像构建。先在开发机或 CI 按香港的 `linux/amd64` 架构构建 Controller/Web 与 Gateway 镜像，验证后导出并在香港加载，记录源提交与镜像 ID，再按下文排空流程切换。不要在有运行负载的小内存 VPS 上直接执行 Compose 并行构建；构建前也不能仅凭服务健康就认定资源充足。不能通过临时增加 swap、改 Docker/system 配置或杀其他进程解决构建压力。

以下仅切换已经加载并核对的本项目镜像，不构建、不重新拉取镜像：

```sh
docker compose --env-file .runtime/controller.env \
  -f compose.yaml -f deploy/compose.production.yaml up -d --no-deps --no-build --pull never controller
nginx -t
```

不要把 `docker compose config` 的完整输出发到日志或聊天，它会展开环境密钥；校验使用 `config --quiet`。`.runtime` 权限 `0700`，`controller.env` 权限 `0600`。模型凭证通过此私有运行配置注入，不能进入镜像构建上下文或 Git。

`deploy/compose.production.yaml` 限制 CPU/内存/PID 与日志大小，Controller 非 root、只读文件系统、移除 capabilities。健康检查只是进程 HTTP 存活，不能替代数据库、模型及节点的业务验收。

Nginx 配置源为 `deploy/nginx.conf`，安装到独立 `/etc/nginx/conf.d/super-leader.conf`。修改后先 `nginx -t`，再平滑 reload；不重启其他应用。证书路径 `/etc/letsencrypt/live/leader.taoai.site/`，沿用已有 certbot 定时器及本域名 deploy hook。

## 原生 Daemon 用户服务

Mac Air 与 Mac Mini 均已安装原生用户服务并认证连接香港，均已显式启用 desktop-send。Mini 已验证原owner状态、历史分页与有效发送资格，尚未向其工作会话实际发送；见 [Mini节点验收](../changes/2026-10-13-macmini-owner-activation.md)。Air维护与实发证据见 [发布记录](../changes/2026-10-12-authorized-release/VERIFICATION.md)。不要另开前台 Daemon。服务直接运行 Go 二进制，不依赖 Node 包装器，也不另启 Codex app-server。

| 项目 | macOS | Linux |
| --- | --- | --- |
| 服务管理器 | 当前登录用户的 LaunchAgent | 当前用户的 `systemd --user` |
| 服务定义 | `~/Library/LaunchAgents/site.taoai.super-leader-daemon.plist` | `~/.config/systemd/user/super-leader-daemon.service` |
| 稳定二进制 | `~/.local/share/super-leader/bin/super-leader-daemon` | 同左 |
| 日志 | state-dir 下 `daemon.stdout.log` / `daemon.stderr.log` | `journalctl --user -u super-leader-daemon.service` |
| 生命周期 | 登录加载、退出后重启；不保证注销或休眠期间在线 | 用户服务管理器启动时加载、异常退出后重启；不自动启用 linger |

检查运行状态（退出码非零表示未安装、未运行或检查失败；运行不等于业务链路健康）：

```sh
~/.local/share/super-leader/bin/super-leader-daemon --service status
cd ~/Workspaces/wechat-super-leader-bot
node local.mjs --check --controller https://leader.taoai.site
```

同一入口支持 `--service start`、`stop`、`restart`、`uninstall`。`start` 不重启已运行服务；`restart` 才显式重启。`stop` 仅停止本次运行，保留登录自启配置；`uninstall` 停止并删除服务定义，但保留二进制、token、日志和 journal。管理动作不需要传密钥，禁止以 root/sudo 操作用户服务。

### 安装与更新

首次安装前须在 Controller 登记节点及其独立 token，将 token 安全写入私有文件；不要放入命令参数或 shell 历史。`--service install` 将当前执行文件原子安装到稳定位置，保存 token 文件并加载服务。更新也使用新构建的二进制执行 `install`，会更新并重启本项目服务，不是兼容迁移。

`deploy/register-node.mjs` 的新节点 token 只接受 8–512 位 ASCII 字母、数字、`_`、`-`，避免 dotenv 注释或 Compose 插值改变凭证；正式生成使用至少 32 个随机字节的 hex/base64url。先 dry-run，确认仅新增精确 node-id 后再串行 `--apply`；同 ID 不同 token 必须停止，不能覆盖旧凭证。token/env 均为 `0600`，父目录为 `0700`。配置修改后须按排空流程重启 Controller 才生效。

新增物理节点先核对实际远端用户目录、既有控制 socket、原服务和 journal；不能仅凭桌面 IPC 存在就宣称可控。Mac Mini 用户目录为 `/Users/macmini`，共享控制 socket 仍缺失；原先精确目标返回 `no-client-found`，经已运行App正常打开该会话后，已通过独立探针与正式HTTP证明原owner/历史可用。随后更新至ef32a2f并开启desktop-send，已取得ready资格，未实际发送。详见 [当前节点证据](../changes/2026-10-13-macmini-owner-activation.md)。不要照搬 Mac Air 路径或启动后端/重启桌面应用。

控制接口缺失不代表必须改变用户桌面配置。`--codex-home` 仍使用纯文件元数据发现，不读取数据库、不创建后端；文件发现不能替代原进程控制。对未加载目标，可在确认身份、归档状态、实际应用版本及原生路由后正常打开既有会话，再独立检查owner与历史。App正常页面载入可能自行resume，不等于Daemon另起后端；禁止根据URL返回成功就自动授权发送。见 [文件发现验证](../changes/2026-10-11-rollout-discovery/VERIFICATION.md) 与 [原生打开语义](../changes/2026-10-13-macmini-owner-activation.md)。

下面是**当前 Mac Air 的维护命令**：使用已存在的私有 token、原 state-dir、香港地址和完整技能根目录。不要将它照搬到另一个节点；Linux 应使用该机器原生构建、独立 node-id/token、实际 socket 和技能目录。

```sh
cd ~/Workspaces/wechat-super-leader-bot/daemon
go build -o bin/super-leader-daemon .
./bin/super-leader-daemon --service install \
  --node-id macair \
  --controller-url wss://leader.taoai.site/v1/daemon \
  --token-file "$HOME/Workspaces/wechat-super-leader-bot/.runtime/daemon-state/service-node-token" \
  --state-dir "$HOME/Workspaces/wechat-super-leader-bot/.runtime/daemon-state" \
  --sock "$HOME/.codex/app-server-control/app-server-control.sock" \
  --desktop-sock "$HOME/.codex/ipc/ipc.sock" \
  --codex-home "$HOME/.codex" \
  --desktop-send --heartbeat 15 \
  --skill-root "$HOME/.claude/skills" \
  --skill-root "$HOME/.claude/skills/ego-browser" \
  --skill-root "$HOME/.agents/skills" \
  --skill-root "$HOME/.agents/skills/ego-browser"
```

每次安装需显式保留完整运行参数；不自动继承旧服务参数或模型/API 环境。服务定义只包含 `--token-file` 路径，不含 token 明文。state-dir 为 `0700`，token 和 journal 为私有运行数据；安装器拒绝覆盖非本项目服务和不安全的目标文件。

`--desktop-sock` 是可选只读状态来源，默认不启用。Mac Air 指向已运行桌面的 IPC socket；不要将此路径照搬到没有桌面应用的 Linux 节点。两平台服务生成器均保留显式参数。它不执行 resume/start-turn、不取得 writer；订阅期间原桌面会保留 follower，可能推迟空闲 owner 的自动卸载。每个观测窗口 30 秒，增量只保留状态投影，断连会移除 follower。未知协议、超过 32 MiB 的入站帧或 revision 不连续时降级；出站仍限 16 MiB，不改变原有控制 socket 的能力。升级桌面应用后重新执行只读探测并验证，不能假定内部协议永远兼容。

状态 Watch 将发现与订阅分开：最多 16 条单目标订阅连接；同一观察器共享两个帧处理槽，初始化握手以及合法 body 的分配、读取、解码和严格投影完整持槽，释放后才发布标量状态。空闲 header 不占槽，超限 header 不等待槽或读取 body；body 有 5 秒绝对读取期限。连接未满时不做 10 秒轮转，已证明 owner 超过上限才公平轮转。超限、身份不符或断连只撤销对应目标。本设计仍每 30 秒重连整个 Watch，窗口边界可能短暂显示重新检查；不是零抖动保证。发现、Snapshot、控制/资格预检与历史另有开销，两个处理槽不等于进程内存上限 64 MiB。

```sh
./bin/super-leader-daemon --probe --desktop-sock "$HOME/.codex/ipc/ipc.sock"
```

独立文件发现的只读检查（项目二进制须先构建；已安装版本也支持这些参数）：

```sh
./bin/super-leader-daemon --probe \
  --codex-home "$HOME/.codex" \
  --desktop-sock "$HOME/.codex/ipc/ipc.sock"
```

`--codex-home` 必须显式提供，不读取 `CODEX_HOME` 默认值；不会创建该目录、journal 或连接 Controller。只扫描未归档目录的完整首条元数据，标题索引仅补已验证 ID。缺失控制接口时返回明确 warning，文件独有会话保持 unknown/read-only；`sources.desktop=true` 仅表示本次 Snapshot 调用成功，必须另看各会话 `desktopObservation.availability`，不能据此声称有可用 owner。Air 已正式启用，其他节点仍须按排空流程更新并在完整 install 参数中显式增加其实际路径；macOS/Linux 服务生成器都保留它，不自动改桌面 transport。

### 原桌面发送开关

`--desktop-sock` 单独使用仍然只读；只有在同一完整安装命令中显式追加 `--desktop-send` 才开启原 owner 发送。该开关默认 false，缺少显式 desktop socket 时启动校验失败。macOS/Linux 服务定义都会保存此参数，但 Linux 构建成功不代表它有可用桌面 owner。

Daemon 在发现精确 owner 后单独执行只读预检（最多两个并发），每个目标检查完成后至少 30 秒再检查，ready 最多有效 45 秒。初次尚未检查使用 epoch 时间和零长度有效期，不代表有资格。owner/revision、busy、unknown 或连接变化立即撤销并保留原检查时间；原 loaded/status/capabilities 不改写。从未发现桌面 owner 的 native-only 会话保持原控制路径；一旦存在桌面资格记录，撤销不得删除该字段来换路。

Controller/Leader/Web 必须一起更新：服务端选择并持久化新命令的 `sendRoute`，派发前复验同路由；旧记录不补选、不重派。页面显示原桌面通道与不可用原因，资格过期立即禁用。真实发送仍执行同连接 owner 预检；这是私有协议且非原子，不保证与 App 同时人工输入无竞争。

香港与 Air 已完成正式 Cookie 接口到原桌面会话的真实发送、精确 turn 回查和重复请求防重发，见 [发布验收](../changes/2026-10-12-release-preflight/VERIFICATION.md)。后续更新仍按下述排空流程核对当前命令/claim并沿用原 journal；不修改 App transport、不另起 app-server、不重启桌面应用。停用时去掉 `--desktop-send`，保留 socket 和原 journal用于精确 turn 只读核查；不能删除数据库或 journal解除 uncertain。开发期证据见 [接线验收](../changes/2026-10-11-desktop-send-route/VERIFICATION.md)。

更新正在使用的服务前，完整核查 pending/accepted/uncertain 命令、有效 Leader claim，以及所有 active 持久计划（包括尚无命令的 waiting 步骤）。不能以 `/v1/status` 的近 50 条命令和最多 12 个计划判定排空；它不是完整数据库清单，读取还可能把过期命令转为 uncertain。使用数据库只读事务统计全量记录，异常结构也应阻断升级。活动计划须先核查并明确继续或取消，不能为部署直接修改其状态。

先预构建镜像与原生二进制，再正常排空并停止唯一 Gateway，保留其 checkpoint。停止 Gateway 不会停止 Controller 的计划调度，也不会关闭 Web/管理写入口；需冻结其余写入口，并在停止 Controller 后通过仍运行的 PostgreSQL 再次核查，防止检查期间进入新任务。发现未决项时不切换版本、不强杀或清空状态，先恢复原运行路径核验。只更新本项目 Controller/Daemon 后恢复原 Gateway；不重建微信基线、删除 journal 或重启无关应用。

上方完整 Air 安装命令显式包含文件发现 `--codex-home` 和原 owner 发送 `--desktop-send`，不是只读探测命令。保留原 node-id、Controller URL、控制 socket、state-dir、token-file、heartbeat 和全部技能根，不将 desktop socket 替换为 journal 绑定的控制 socket。安装会依次停服务、替换本项目二进制/服务定义再加载，不是整体事务，失败不会自动恢复旧服务。回退发送能力优先去掉 `--desktop-send` 并保留同版只读核查与原 journal，不恢复陈旧数据库。详细路由证据见 [接线验收](../changes/2026-10-11-desktop-send-route/VERIFICATION.md)。

Mac Air 的 journal/token/log 位于 `~/Workspaces/wechat-super-leader-bot/.runtime/daemon-state/`。运行中不要再执行 `node local.mjs --daemon`；独占 journal 会拒绝第二实例，不能删除文件或换空目录绕过。更新二进制不改变 journal 绑定；更换 Controller/node/socket 必须先按下节核验迁移。macOS 文件日志尚未配置轮转，不应将当前安装视为完整长期运维方案。

Linux 已通过参数/权限/生命周期单测及 amd64 交叉编译，尚未实机验收。运行用户需要可用的 systemd 用户会话；如需无人登录时常驻，另行决定并授权 linger，不由安装器自动修改系统策略。两平台的控制能力都依赖既有 Codex socket；文件发现可独立降级，但 Daemon 自启不等于 Codex 自启。

## 数据与切换

本次从本机 PostgreSQL 直接流式迁移到香港空库，没有生成 dump/备份文件。迁移前确认无在途命令、停本地 Controller；迁移后逐表核对记录数和整行摘要。原本地数据库卷保留，旧 Controller 停止，不能同时作为第二个编排权威启动。

Daemon journal 防重放记录绑定节点、Controller URL 和本机 socket。切换 Controller 不得删除 journal、换空目录绕过保护或自动回退原地址。运维迁移须显式检查原绑定和所有回执终态，确认数据库迁移无损后再更新绑定。故障中存在未决记录时应先核查原任务，不能重新发送。

回退不是只换一个 URL：香港上线后的新命令、消息、记忆不能丢弃。需先停止新的写入和节点服务，对香港数据库做反向流式迁移并核对，显式迁移 journal 绑定后才启用本地 Controller。保留原本地卷不表示它仍是最新数据。

多技能组合还有读取合同的回退边界：旧 Controller 的技能引用校验为 `max(1)`，读取命令时无条件执行，包括 completed/failed 终态记录。新版已保存含 2–4 份技能引用的命令及结果传递的冻结输入合同，即使已排空也不能直接退回旧镜像。不能删除或改写历史记录规避校验；需使用支持同一数据合同的修复版本，保留数据库和原 journal。部署后浏览器正常刷新以加载同版 Web；不要为保留旧标签页而放宽严格校验。

## 独立微信 Gateway

Gateway 是香港独立 Docker 服务，不依赖 Mac 的轮询进程；Mac 休眠时微信入口仍可用，但无法向离线的 Mac 会话派发。服务仅在显式选择 `wechat` profile 时启动，不发布宿主端口。只读账号文件与可写 checkpoint 分开挂载，容器不注入模型 key、数据库密码或节点 token。

部署前核实账号的 `userId` 与真实入站发送者一致，只授权该操作者。`deploy/authorize-wechat.mjs` 默认 dry-run，`--apply` 才将空的 `ALLOWED_CHAT_IDS` 设置为账号本人；它拒绝覆盖其他身份，其他配置字节保持不变。参数使用 `--credentials` 和 `--env-file` 路径，不传入明文 token。更新后只重建本项目 Controller 以加载允许名单。

运行文件位于 `/opt/super-leader/.runtime/wechat/`：账号 `account.json` 只读挂载、权限 0600、容器 UID 1000 可读；`state/` 属于 UID 1000、权限 0700，checkpoint 和健康文件为 0600。账号原件保留不变，香港副本是运行所需凭证，不是备份。不要把账号、context token、cursor 或完整展开的 compose 配置打印到日志。

首次启用先建立基线，再启动。基线最多读取 20 批，必须读到**原始消息数组为空**才完成；只记录上下文、去重和 cursor，不调用 Controller，不发送微信回复。失败后仅允许续作未完成的基线，不能对已有正常处理记录再次执行以跳过积压。

```sh
cd /opt/super-leader
docker compose --env-file .runtime/controller.env \
  -f compose.yaml -f deploy/compose.production.yaml -f deploy/compose.gateway.yaml \
  --profile wechat run --rm --no-deps --no-build --pull never gateway --establish-baseline
docker compose --env-file .runtime/controller.env \
  -f compose.yaml -f deploy/compose.production.yaml -f deploy/compose.gateway.yaml \
  --profile wechat up -d --no-deps --no-build --pull never gateway
```

上述基线命令仅用于首次上线，且要求已加载并核对 Gateway 镜像，不是每次更新的步骤。正常更新使用开发机/CI 构建并加载的镜像，排空后执行带 `--no-build --pull never` 的 up，始终沿用原 state。重复基线被拒绝是保护生效，不能删除 state 绕过。

```sh
docker compose --env-file .runtime/controller.env \
  -f compose.yaml -f deploy/compose.production.yaml -f deploy/compose.gateway.yaml \
  --profile wechat ps gateway
docker compose --env-file .runtime/controller.env \
  -f compose.yaml -f deploy/compose.production.yaml -f deploy/compose.gateway.yaml \
  --profile wechat exec -T gateway node dist/index.js --healthcheck
```

健康检查不读取微信凭证，只检查当前进程和近期成功轮询。新进程更换 run ID 并清空旧成功时间，失败记录安全错误类型。**空轮询正常不代表 Controller、模型或会话执行可用**，完整链路仍需下节人工验收。

同一微信账号不得在两台机器并行轮询。香港启用后，本机 `.runtime/local.json` 的允许名单维持为空，不运行 `node local.mjs --gateway`。停用时只 `stop gateway`，保留账号、state 和数据库；不要 `down -v` 或清除 checkpoint。实际部署与验收结果见 [验证记录](../changes/2026-10-10-control-plane/VERIFICATION.md)。

### 计划与持续目标通知

默认关闭。完成、失败或授权到期时，Controller 在计划终态事务内保存一条通知；持续目标首次 active→completed/blocked/expired 在目标 CAS 事务保存一条通知。取消不另外通知，blocked 后 cancelled/expired 不重写或二次发送；目标 completed 明确只是根据精确记录作出的模型判断。只通知来源 ID 和静态状态摘要，不附带目标/条件/原会话输出、错误细节或控制台登录凭证。

当前唯一开关为 `GATEWAY_NOTIFICATIONS=true` / `--notifications`，仅注入 Gateway，仓库模板默认 false。历史香港曾用旧开关启用固定计划通知，唯一既有通知为 uncertain，见 [原记录](../changes/2026-10-13-wechat-notification-activation.md)；新版本不识别旧开关，发布前须精确迁移项目私有 env 中的布尔值，不动其他凭据或配置。

本次通知 JSON 从 executionId 统一为 `source:{type:plan|goal,id}`，须 Controller/Gateway 成对升级，不能只更新 Gateway 或继续旧 Gateway 领取新合同。旧记录事务迁移只改来源表达，保留原 status/attempt/time/text；旧终态不回填。先在外部构建验证、香港加载镜像，再排空并正常停唯一 Gateway/Controller，迁移后复核旧通知及非通知业务摘要，启动同合同 Gateway。迁移成功后不能直接回退旧二进制，应关闭通知并保留记录或使用同合同修复版；具体步骤见 [升级合同](../changes/2026-10-13-goal-notifications/TECH.md) 与 [验证状态](../changes/2026-10-13-goal-notifications/VERIFICATION.md)。不要运行第二份 Gateway 或重置 state/cursor、数据库、journal。关闭时设新变量 false 后正常更新 Gateway。

通知列表只请求当前有聊天 context 的目标，并与 Controller 当前允许名单求交；无 context 不领取，超过128个目标会轮转。`--run` 每次入站轮询前最多处理4条，`--poll-once` 在正常入站周期成功后处理。繁忙的模型调用和长轮询可能延迟通知；现有 context 也可能过期，不能保证永久主动触达。

每条通知的事件期限是24小时，领取期限是60秒。领取响应丢失不发送，也不自动重领。微信回执缺失或结果不明保存为 `uncertain`；记录回执可以重试，但绝不再次发送。`accepted` 只证明微信接口明确受理，不证明人已收到或已读。领取后、发送前崩溃可能漏发；允许名单撤销和外发之间仍有竞争窗口，不能宣称 exactly-once 或必达。pending 过期只显示 expired，claimed 过期只显示 uncertain，均不重放。

持管理 Bearer 可通过 `GET /v1/notifications/<计划或目标ID>` 核查 `{notification}`，并复核 source（Cookie/节点 token 不可用）；不要打印 Bearer、context 或账号信息。不要通过重新 claim 或造新计划来验证未知发送结果。旧终态计划/目标不会自动回填通知；重新开启开关后，已有且未过期、未领取的 pending 仍可能被发送，开启前应确认其范围。

通知处理在健康检查中拥有最多235秒的有界processing阶段，结束清理不覆盖其他阶段；不会增加入站计数或刷新`last_poll_succeeded_at`。超过预算仍报告不健康。入站健康不证明通知成功；首次真实通知为uncertain且原部署没有保存发送错误类别，不能从空日志/入站错误0推断原因。合成场景证据见 [通知验收记录](../changes/2026-10-12-plan-notifications/VERIFICATION.md)，真实启用与限制见 [现场记录](../changes/2026-10-13-wechat-notification-activation.md)。

香港Gateway现运行诊断补丁`3a750e7`：发送失败的uncertain回执持久化成功后，记录`notification_send_failed`，仅含notificationId、attemptId和安全errorType。原始异常、账号/context、正文不进入日志。诊断管道短写或关闭时正常收尾并退出2，不再对同一坏stderr写错误；服务重启后原claim仍不可重领。该事件不补记历史原因，receipt本身保存失败仍按既有cycle错误报告，不能因没有该事件便认定发送成功。不要为复现日志再发旧通知。

## 微信人工验收

香港 Controller 与 Gateway 已完成重新构建与启动（沿用既有 PostgreSQL 卷不变，两项服务均处于 healthy 状态；Gateway `last_poll_succeeded_at` 为 2026-10-11T09:05:17.641Z，errors 为 0，已核实加载本人 allowlist）。正式 `/v1/messages` 接口已使用本人 chatId 模拟文本“给我控制台链接”完成验证，真实调用 `gpt-6.1-sol`（12093ms）成功返回 1 条免密链接，经后台兑换（200）与退出（200）验证，未外发微信消息；真实浏览器初次打开自动登录后地址栏仅保留 `https://leader.taoai.site/`，无 token 输入框，本地 storage 为 0，HttpOnly Cookie 不可被脚本读取，刷新 session（200）正常展示 macair 节点通过。

上述运行证据不替代全链路最终验收。仍需待用户在微信端发起实际入站消息并使用内置浏览器完成点击与登录交互确认。最终验收时由用户在已接入的微信对话发送“给我控制台链接”验证免密登录，并发送：“查看 Mac Air 在线节点和会话”。随后选择明确的专用测试会话，让它仅回复 `WECHAT_OK`、不调用工具不改文件。核对计划中的节点、会话与内容后回复“确认执行”，最后查询原任务结果，核对精确 turnId、completed 和输出。

不能把登录成功、一次发消息 HTTP 200、空轮询或模型模拟测试当作真实微信端到端通过。native notLoaded 不等于原桌面不可控，须单独检查 sendAvailability；只有没有有效发送路线时，才由用户在原客户端打开目标，不隐式 resume 或替换成新会话。

## 仍需单独验证

手机运营商网络的真实延迟、长时间断网/休眠后的恢复、生产负载、异地灾难恢复与真实微信均不能由一次部署替代。本次没有创建自动备份策略；PostgreSQL 单节点仍存在故障风险。公司机器的接入和数据边界、Claude/Grok 等其他已有 CLI 适配仍需各自验收。
