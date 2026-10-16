# wechat-super-leader-bot

> 微信 Super Leader：用自然语言查询、控制多台机器上已有的 Agent 会话，
> 在明确授权后安排任务、传递结果，并通过 Web 工作台核对进度与回执。

## 架构总览

```mermaid
flowchart TB
  WX["微信"] --> GW["独立 Gateway · TypeScript"]
  GW --> C["Controller / Super Leader · TypeScript"]
  W["Web 工作台 · React"] -->|HTTPS + Cookie| C
  C --> M["Responses API · 模型决策"]
  C --> PG[("PostgreSQL · 命令 / 计划 / 目标 / 记忆")]
  D["宿主机 Daemon · Go"] -->|主动 WSS| C
  D --> O["已有 Codex 桌面 owner / 控制 socket"]
  D --> T["显式配置的已有 CLI 终端"]
```

Controller 是唯一编排权威：模型提出决策，Controller 校验授权、冻结输入、持久化和派发。
Gateway 独立维护微信登录与同步状态，负责轮询、转发和回复，不调用模型或另建任务。
Daemon 原生运行在 Mac/Linux 宿主机，连接已有会话；用户仍可在原客户端操作这些会话。

香港 Docker 运行 Controller、Web、PostgreSQL 和独立 Gateway；宿主机主动连接 WSS，
不需要给 Mac 开公网入站端口。桌面控制优先使用已有 owner；未加载会话可通过配置的
app-server 按原 ID 恢复后发送，不创建替代会话。已有 writer 冲突时明确失败，不抢占、不自动换路。

## 入口与代码布局

| 入口 | 用途 |
| --- | --- |
| [leader.taoai.site](https://leader.taoai.site) | 线上控制台，通过微信一次性链接登录 |
| `http://127.0.0.1:8790` | 独立本机 Controller / Web |
| `/health` | Controller 存活检查 |
| `/v1/daemon` | 认证 Daemon WebSocket |
| `scripts/local.mjs` | 本机初始化、启停、状态查询 |
| `scripts/verify.mjs` | 合成目标的统一验证入口 |

```text
controller/src/ commands/、http/、leader/、nodes/、notifications/、sessions/、skills/、store/
daemon/cmd/     super-leader-daemon CLI 入口
daemon/pkg/     client/、codex/{appserver,desktop,rollout}/、protocol/、service/
gateway/src/    cli/、controller/、runtime/、wechat/
web/src/        api/、auth/、features/{leader,sessions,status}/
scripts/        local.mjs、verify.mjs、lib/、ops/
tests/          跨组件集成测试、CLI 与部署测试
deploy/         Dockerfile、生产 Compose、Nginx 与节点配置工具
compose.yaml    本机控制平面基础编排
```

项目说明集中在本 README；运行合同与验证以对应源码和测试为准。

## 使用方式

在微信中可以说：“看看这台机器有哪些会话”“这个会话进展怎么样”“给我控制台链接”。
具体会话的历史查询只读取已记录内容，并标明来源、获取时间和裁剪，不把元数据冒充输出。

| 能力 | 授权与执行方式 |
| --- | --- |
| 单步任务 | 先展示准确目标、内容和技能；用户确认后发送到原会话 |
| 固定计划 | 最多 4 步，冻结依赖与目标；精确完成回执才解锁后继 |
| 结果传递 | 预览明确共享来源；后继使用前驱精确完成的已记录结果 |
| 持续目标 | 确认目标、完成条件、会话范围和预算后，根据结果决定下一步 |
| 有序技能 | 每任务最多 4 个技能，确认和派发均核对顺序与版本摘要 |
| 终态通知 | Gateway 显式开启后，在原聊天发送静态状态摘要 |

固定计划预览 10 分钟内确认，授权最多延续 24 小时；取消只停止后继，不终止已运行任务。
持续目标同时约束次数和时间；失败、结果不明、证据不足或预算耗尽时停止并保留记录。
每个聊天同时只允许一个未结束的持续目标或固定计划。

Web 提供机器与会话搜索、原来源历史、直接发送、计划和目标进度。
手机底栏切换会话与看板，聊天顶栏保留模型、状态和详情入口；返回列表保留草稿与阅读位置。
向上滚动自动加载更早历史，新消息不会打断阅读；看板优先展示待处理和执行中记录，完成记录可展开。
状态通过认证 SSE 更新，断流后轮询兜底；历史采用快照与分页，不是 token 流式输出。
读取旧消息时保留滚动位置；来源失效后暂停，用户可显式重新读取最新页。

## 控制台登录

1. 在已授权微信聊天中发送“给我控制台链接”。
2. 打开形如 `https://leader.taoai.site/#login=<一次性凭证>` 的链接。
3. 页面立即清除地址栏 fragment/query，兑换 `HttpOnly` Cookie；登录态固定有效 1 小时。

链接有效 1 小时、仅可兑换一次，持有即可登录，请勿转发。
浏览器不保存管理 Bearer token；Cookie 仅授予状态/历史查询与准确会话发送权限。
发送要求同源 Origin、专用 intent header 和有效会话资格，通用管理写接口不接受 Cookie。

## 本机开发

需要 Node.js >=24、pnpm 11.8.0、`daemon/go.mod` 指定的 Go，以及本地 Docker / Compose。
先安装三个组件的锁定依赖，并构建前台 Daemon：

```sh
pnpm --dir controller install --frozen-lockfile
pnpm --dir gateway install --frozen-lockfile
pnpm --dir web install --frozen-lockfile
pnpm --dir gateway build
(cd daemon && go build -o bin/super-leader-daemon ./cmd/super-leader-daemon)
node scripts/local.mjs --init
```

`--init` 只创建不存在的私有配置，默认微信允许名单为空。
`.runtime/local.json`、`.runtime/daemon-state/` 和微信状态是持久运行数据，不提交、不删除。

自然语言模式使用 Responses API。启动前通过私有进程环境配置：

| 变量 | 用途 |
| --- | --- |
| `LEADER_MODE=model` | 启用模型决策；默认 `rules` 仅用于诊断 |
| `LEADER_MODEL_BASE_URL` | 当前 provider 的 API 基址，包含 `/v1` |
| `LEADER_MODEL_NAME` | 实际可用模型名 |
| `LEADER_MODEL_API_KEY` | provider 密钥，不放入仓库或 shell 历史 |
| `CONSOLE_PUBLIC_URL=http://127.0.0.1:8790` | 本机签发控制台链接所需的公开 origin |
| `CONTROLLER_HTTPS_PROXY` | 可选的实际出网代理地址 |

```sh
node scripts/local.mjs --up
node scripts/local.mjs --daemon
# 另开终端
node scripts/local.mjs --check
node scripts/local.mjs --sessions
```

`--up` 构建本机 Controller / Web / PostgreSQL；启动器默认使用独立 `docker-compose`。
`--daemon` 为前台开发运行；已有用户服务在运行时，通过该服务管理节点。
`--down` 停止本机容器并保留数据库卷。已连接香港的节点使用远端查询入口，
不要再启动第二个编排权威；`--gateway` 会真实轮询微信，必须先配置并核实允许名单。

## 原生 Daemon

macOS 使用当前登录用户的 LaunchAgent，Linux 使用当前用户的 `systemd --user`。
稳定二进制位于 `~/.local/share/super-leader/bin/super-leader-daemon`：

```sh
~/.local/share/super-leader/bin/super-leader-daemon --service status
node scripts/local.mjs --check --controller https://leader.taoai.site
node scripts/local.mjs --sessions --controller https://leader.taoai.site
```

同一入口支持 `--service install|start|stop|restart|uninstall`。
安装/更新使用本机架构的新二进制，显式提供本机 node-id、WSS 地址、私有 token-file、
原 state-dir、实际 socket 与完整技能根目录；不要复制另一台机器的路径或凭证。
`uninstall` 删除服务定义，保留二进制、token、日志和 journal。

| 参数 | 作用与边界 |
| --- | --- |
| `--sock` | 已有 Codex 控制 socket；可按原 ID 恢复未加载会话，不创建后端 |
| `--desktop-sock` | 已有桌面 IPC 的状态、模型与历史观测 |
| `--desktop-send` | 显式开启原桌面 owner 发送，要求 desktop socket |
| `--codex-home` | 只读文件元数据发现，不等于历史或发送授权 |
| `--terminal-sock` / `--terminal-pane` | 显式指定已有终端和准确 pane |
| `--terminal-history-root` | 逐提供方授权已记录 CLI 历史目录 |
| `--terminal-send-mode=non-atomic` | 显式接受已有 PTY 单步输入的非原子边界 |
| `--probe` | 只读诊断，不连接 Controller 或写 journal |

桌面观测与发送资格独立；失联、过期或 owner 不符时降级为只读，不自动换路。
桌面内部协议会随客户端版本变化，升级后需要重新核对。
Linux 用户服务不自动启用 linger；服务在线不代表原会话可控。

## 部署与微信运行

基础编排为 `compose.yaml`，生产限制为 `deploy/compose.production.yaml`，
微信独立服务为 `deploy/compose.gateway.yaml`，仅显式选择 `wechat` profile 才启动。
镜像入口为 `deploy/Dockerfile.controller` 和 `deploy/Dockerfile.gateway`。

私有生产配置位于 `.runtime/controller.env`。只读检查使用以下命令，避免输出展开后的密钥：

```sh
docker compose --env-file .runtime/controller.env \
  -f compose.yaml -f deploy/compose.production.yaml -f deploy/compose.gateway.yaml \
  --profile wechat config --quiet
docker compose --env-file .runtime/controller.env \
  -f compose.yaml -f deploy/compose.production.yaml -f deploy/compose.gateway.yaml \
  --profile wechat ps
```

生产镜像先在开发机或 CI 按目标架构构建并验证，再加载和切换。
更新前全量核查在途命令、claim、计划和目标，并排空唯一 Gateway、冻结写入口；
状态页只展示近期记录，不能作为排空依据。沿用原数据库、节点 journal 与微信 checkpoint。

同一微信账号只能有一个 Gateway 轮询。`ALLOWED_CHAT_IDS` 授权操作者，登录凭证不能代替授权。
新账号首次运行前执行 `--establish-baseline`，读取到原始空页，只记录上下文、去重和游标，
不回复历史消息；正常重启沿用已有基线，不重新建立。通知默认关闭，
通过 `GATEWAY_NOTIFICATIONS=true` 或 `--notifications` 显式开启，未知投递结果不重发。

## 验证与结果边界

```sh
node scripts/verify.mjs                     # 完整验证
node scripts/verify.mjs --suite unit        # 单测、构建、Go race/vet，无需 Docker
node scripts/verify.mjs --suite integration # 构建、临时 PostgreSQL 与集成验证
node scripts/verify.mjs --list              # 查看计划，不运行检查
```

完整验证使用本地 Unix Docker socket 和 `postgres:16-alpine`，拒绝远端 Docker engine。
验证清除真实业务配置与 LIVE 开关，使用合成模型、微信和桌面目标；
不部署或触达正式会话。CI 在 Ubuntu 运行全量、macOS 运行 unit，使用 Node 24。

| 回执 | 能证明什么 |
| --- | --- |
| `accepted` | 已受理，需要继续核对原请求与准确 turn |
| 精确完成回执 | 对应原任务已结束，并有该 turn 的已记录结果 |
| CLI `input-written` | 输入已写入，执行与完成未确认，不能解锁后继或参与目标闭环 |
| `uncertain` | 结果未知，核查原请求，不改 requestId 重发 |
| 微信发送 `accepted` | 微信接口受理，不证明手机收到或已读 |

持续目标的“完成”是模型依据记录判断条件满足，不等于独立业务验收。
已有 Air 单节点原会话联调与微信登录链接核验；真实手机会话控制、跨物理机闭环、
Mini 实际发送、真实 CLI 与 Linux 服务仍需各自验收。
