# 发布前置与构建事故记录

日期：2026-10-12（Asia/Shanghai）；下述时间另标 UTC。初始候选为 `4957505dbe6f21011e8ffe2b8c03bbed641a8402`，后续构建修复为 `3488d3a13fb47a1282a89a547c7f63c242dc20d8`。香港已切换该镜像；真实验收发现的订阅故障经 `9514d34` 隔离及 `058af3d` 资源调度修正，已更新 Air 并完成下述正式接口复验。历史失败保留，不代表所有会话、真实微信或完整生产保障均已验收。

## 发布前置

- `gh repo view TaoSama/wechat-super-leader-bot --json nameWithOwner,isPrivate,defaultBranchRef`：私有仓库，默认分支 main。`git ls-remote --heads origin main` 为 `8fc6114df302fc73e65fa1614187dabbc7f8fcb6`，新版尚未推送。
- Air 为 Mac17,3 / arm64。正式 LaunchAgent PID 4148，使用原 WSS 地址、token-file、state-dir、control socket、desktop socket、15 秒心跳和四个技能根；尚未启用 codex-home 或 desktop-send。新二进制本地构建成功，未安装。
- 香港为 x86_64。构建前 Controller、Gateway、PostgreSQL 均 healthy；数据库卷为原 `super-leader-controller-db`，账号与 checkpoint 仍是原挂载。
- 管理状态返回 macair 在线、15 个会话、83 个技能。随后直接用 pg 客户端执行 `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`，完整统计命令和 Leader 状态，不实例化带启动迁移的 Store。
- 2026-10-11 19:52:41 UTC：commands 为 completed 14 / failed 2；4 个 Leader state，有效 inflight 和待确认计划均为 0；没有 leader_executions 表。初次查询错用了 plan_notifications 表名，恢复核查已按源码更正为 leader_notifications，不能把错表查询当成通知清空证据。

两个独立协作单元完成只读发布审查，指出并已补入运维手册：状态接口只有近 50 条命令和最多 12 个计划，不能证明全量排空；必须核查所有 active execution，停止 Gateway 不停止 Controller 调度或 Web/管理写入口。安装服务也不是整体事务，须保留原全部绑定参数和 journal，不靠删状态回滚。

## 失败的香港构建

使用 `git archive` 流式上传当前提交的 Controller/Gateway/Web、Dockerfile、Compose、deploy/scripts，archive 为 1,638,400 bytes，不含 `.runtime`、凭据或数据库。源码已更新，但运行镜像没有因此切换。生产目录不是 Git checkout；其旧源码中存在 AppleDouble `._*` 元数据，本轮未删除或创建备份。

随后误在生产 VPS 执行：

```sh
docker compose --env-file .runtime/controller.env \
  -f compose.yaml -f deploy/compose.production.yaml -f deploy/compose.gateway.yaml \
  --profile wechat build controller gateway
```

该选择不当：2 GiB、无 swap 的宿主同时承担现有服务和多个 pnpm 安装阶段。没有事先测量可用内存或将构建隔离到开发机。构建期间：

1. SSH 出现 banner exchange 超时；重试曾成功，读到可用内存约 173 MiB。
2. 香港健康接口从 200 变为 502，再出现 10 秒超时；Mini 独立访问也超时。
3. 20:01:56 UTC 读到 `MemAvailable: 45720 kB`、1 分钟 load 53.41。
4. 内核日志确认 global OOM，Killed process 113161。日志对应容器 ID 经 inspect 精确映射为 `/super-leader-controller-1`，恢复时 restart count 为 2。恢复后的 OOMKilled=false 不推翻此前内核事件；不能以 restart count 推断每次重启都是 OOM。
5. 原 build PID 112311；工具会话 35111 最终自行以 exit 1 返回，失败位于 Dockerfile.controller 第 15 行的 `pnpm install --frozen-lockfile`。日志还有大量依赖请求错误与重试，不能将所有安装错误单独归因于 OOM。

事故恢复阶段没有发 SIGKILL、取消构建、主动重启 Controller、改 swap/Docker/系统配置或重启 Codex App。曾请求用户批准取消本次构建；构建自行失败退出后已告知不再需要取消，不把未回复当作授权。

## 恢复证据

20:04:17 UTC，原 build PID 已不存在，MemAvailable 回升至 975,408 kB。Controller、Gateway、PostgreSQL 均 healthy。Gateway 与 PostgreSQL 的运行持续时间没有因本轮被替换；Air PID 仍为 4148。

Controller 仍运行原镜像 `sha256:8ba13f9f05033c769f4a17f24e36d15201c74c98187099ffdff021110a18759e`，Gateway 仍为 `sha256:bc9a16fbc213c1971c380257e6d056462bb454f2fb5cc226e7b53fde2d6cb356`。没有执行 up/recreate/install，不能宣称新版上线。

恢复后重复完整只读数据库核查：commands 仍为 completed 14 / failed 2，4 个 Leader state，有效 inflight / 待确认均为 0；leader_executions 和正确名称 leader_notifications 均不存在。计数保持不变不是逐行完整性或物理掉电恢复验证，没有据此声称所有数据完全无损。

Gateway 健康检查为 ok=true，consecutiveErrors=0，totalErrorCount=1（构建前为 0）；保留这个错误增量，不把恢复后的健康说成全程无故障。20:04:44 UTC 从 Mini、20:08:30 UTC 从 Air 查询 `/health` 均返回 ok。

## 调整后的发布路径

香港不再执行构建，运维手册已改为开发机/CI 构建 `linux/amd64` 镜像、核对并加载后再 `up --no-build --pull never`。本机 Colima 为 aarch64 / 4 CPU / 8 GiB，首次读取可用内存 5,888 MiB；支持 linux/amd64。

本机缺少 buildx 插件，未安装系统插件或更改 Docker 配置。将官方 v0.38.0 的 darwin-arm64 二进制下载到本轮临时目录，仅在官方 `checksums-signed.txt` 中的 SHA256 匹配后执行：`85989b895add5f119c1ccf8eada2f6892fc33ccf16bd8917638eae404ef26344`。普通 checksums.txt 不含签名后的 macOS 二进制；第一次校验因未找到条目而失败，没有绕过校验。

首次本地构建通过固定提交的 git archive 作为 stdin 上下文，不读真实业务 `.env` 或凭据；目标 Controller 标签为 `super-leader-controller:4957505`。工具会话 48927 已以 exit 1 结束：Web 阶段 pnpm 安装报告完成后，模拟 x86 Node 在 `uv__io_poll` 触发 `errno == EEXIST` 断言并 abort（构建步骤 exit 134），Controller 阶段随之取消。没有得到完整镜像，不能当作项目单测失败或靠原样重试解决。

调整为在原生 BUILDPLATFORM 阶段安装依赖和编译，仅最终运行阶段采用目标架构；同时核查生产依赖闭包没有平台原生模块。修复后的镜像验证如下，不把阶段成功当作镜像完成。

20:12:00 UTC 再次只读核对香港：运行镜像仍是上述旧版；commands 仍为 completed 14 / failed 2，有效 claim / 待确认均为 0，两张新增计划表仍不存在。

## 保留边界

没有推送、启动第二个生产 Controller/Gateway、建立新微信基线、删除 journal、复制生产数据库或发送真实微信测试消息。Air 在发现订阅故障后曾正常停止，随后已恢复并更新至 `058af3d`；正式接口复验结果见末节。Mini 指定终端仍待用户提供，公司机器接入与完整 CLI 控制仍未完成。构建与 HTTP 健康不证明会话控制或长期稳定性。

## 镜像验证与正式切换

- 提交 `3488d3a`：两个镜像的 toolchain 使用 BUILDPLATFORM；目标运行阶段不执行 RUN，Gateway 目录通过带所有者的 COPY 提供。没有改依赖版本或安装系统 buildx 插件。
- `node --test deploy/image-build.test.mjs verify.test.mjs deploy/config.test.mjs deploy/gateway.test.mjs`：首次 19/20，旧 Gateway 测试仍断言无 platform 的 FROM。按新契约更新该断言后 20/20；没有移除测试。新镜像源码仍是精确 `3488d3a`，后续测试和文档不影响构建产物。
- 两镜像通过精确 git archive 构建上下文，本地串行 `buildx build --platform linux/amd64 --load` 成功。Controller/Web 使用 pnpm 11.8.0；Gateway 按其现有 devEngines/锁文件使用 11.28.5，未改锁文件。
- Controller 镜像 ID：`sha256:9670ae6b265ce46e46c22f1898965efdb5393e89e02b77c29649958333a7ccba`；Gateway：`sha256:f5b861b56bf35baeb0751240f6d3bcaf1008c9422172a0774714ea46720bd623`。本地与香港 inspect 的 ID、各自 10/11 个 RootFS 层、架构、revision、环境和启动配置全部一致。
- 本地及香港分别运行 `docker run --rm --network none --read-only --cap-drop ALL --pids-limit 128 --memory 256m --entrypoint node …`：x64、UID 1000；Controller 实际扫描 1597 文件、220 条依赖链接、92 个 package.json，无越界/悬空链接、原生二进制或平台限定包，5 个根生产依赖均可导入。92 为文件数，不是独立依赖包数（闭包为 83 包）。Gateway 仅剩 3 个依赖管理文件、0 个链接/包，运行目录 UID 1000、/tmp 1777。
- 隔离网络/纯内存的 Controller 启动、健康、鉴权状态与 Web 静态首页通过；Gateway 模块导入及 `--help` 通过。没有给烟测容器注入生产凭据、数据库或桌面 socket，退出自动移除。
- `node verify.mjs --suite integration`：PASS 6 checks，包括真实临时 PostgreSQL、Go Daemon 模拟 owner、固定路由/精确 turn、持久计划恢复、Cookie、SSE、通知防重放和登录鉴权；不代表真实微信验收。
- 20:20:00 UTC：完整 PG 只读审计通过；Gateway、Controller 使用 `docker stop --timeout -1` 正常退出（exit 0），没有超时强杀。Controller 停止后再次直接通过 PG 检查全部命令、claim、待确认计划、active execution 和通知，异常结构也会阻断升级。
- 停止后的业务摘要：commands 16 / `9fd3a3dd3776a1043d2d4bd2b0af6d18`；messages 29 / `5261a5f769693fb62e869bc31a6ec09a`；leader_states 4 / `7c85c3f29f1058c599ccdb031e6bf133`。切换 Controller 后、恢复 Gateway 前计数和摘要完全一致。commands 使用共同业务字段，排除新加的 send_route 列；不是磁盘级灾备证明。
- 通过 `up -d --no-deps --no-build --pull never` 只替换本项目 Controller/Gateway，PG 未重建、卷未更换。Air 使用完整原绑定参数追加 `--codex-home`、`--desktop-send`，安装后 PID 75168。20:20:50 UTC HTTP 健康正常；随后三容器 healthy，两个新容器 restartCount=0，Gateway 当前进程错误计数 0（不能抹去旧进程的构建期错误）。

## 真实会话验收发现的订阅故障

复用并恢复专用会话 `01a12a91-5777-75e0-8df3-4ee968565997`，通过原宿主准备 turn `01a12ca0-85d0-7392-a929-ca5bb4b1d361`，4953 ms 完成，正文 `READY_FOR_RELEASE_20261012`。没有新建测试会话或修改文件。Controller 发现 18 个会话、模型 `gpt-6.1-sol`，但专用会话的原控制状态仍是 notLoaded、桌面 availability 持续 unavailable；未通过 HTTP 发送标记。

三项交叉证据：

1. 正式 Daemon 每 2 秒记录订阅断开，所有桌面 ready 为 0。
2. `LIVE_CODEX_DESKTOP_SOCKET=… LIVE_CODEX_DESKTOP_SESSION=01a12a91-5777-75e0-8df3-4ee968565997 go test ./pkg/codex -run '^TestLiveCodexDesktopReadonlyModelObservation$' -count=1 -v`：PASS，单 fixture 快照 0.08 秒，模型/owner 匹配且 idle。
3. 临时只读 Watch 分别请求“主任务+fixture”及“仅主任务”，均得到 `read desktop subscription: desktop frame too large`。旧聚合连接在一个目标超限后退出，客户端撤销整组会话的可用状态。帧拒绝发生在 header，不能跳过错误继续解析尚未消费的 body。

20:24:12 UTC 再次 PG 全量审计仍为 16 条终态命令、无有效 claim/活动计划，随后正常停止本项目 Air Daemon，避免不断重试放大负载；Codex App 和香港服务未停止。当时决定按目标隔离订阅、有界并发与公平调度，32 MiB 限额不提高；后续实现、恢复与归档结果见下文。

### 隔离修复的独立反例

修复将共享 owner 发现与逐目标状态订阅分开：发现连接不 follow 状态，状态订阅最多两个独立连接。它们与控制/资格预检和历史池的预算分开；32 MiB 是每帧上限，不是整个进程内存上限。超限帧在 header 阶段拒绝，不分配或读取超限 body。每个目标仍须核对精确 owner、连接收件人、会话、host、协议版本和 revision，不允许自动换 owner。

实现过程中独立回归发现并保留以下问题，不将中间补丁当成已交付：

- 新 discovery 路径重复 cleanup 导致取消后等待不退出；定向 race 测试超时，栈停在 `workers.Wait → discoverDesktopOwners → connectDesktopClient.cleanup`。移除该路径的重复清理后取消回收通过；没有扩大 transport 改造。
- 直接按全部候选数量轮转会使大量无 owner 会话驱逐仅有的一两个健康会话；独立测试改为 18 个候选、1/2 个 owner，在同连接跨三个 slot 收到 revision 2 且无中途 unavailable。
- 固定 tick 可能跨过短窗口内的实际订阅轮换，7 个 owner 连续四窗仍有目标未 follow；改用最早实际 slot 到期时间。跨窗公平还须检查响应顺序与实际 follow 游标，而不只证明 discovery 已发送。
- 补充“七目标全部已知、80 ms 总窗口小于 200 ms slot、proof 间隔 5 ms”的反例，三次均稳定复现 `map[a:4 b:4]`，其余五目标饥饿。已知 lane 增加按实际 follow 游标的 resolved gate，未知候选仍可跳过；错误/超时响应释放对应 gate。未放宽原强反例。修后独立隔离全组 `go test -race -count=3 ./pkg/codex -run '^TestDesktopSubscriptionIsolation' -timeout 30s` 通过。

20:34:01 UTC 再次只读 PG 审计通过：14 completed / 2 failed，无在途；HTTP health 正常。Air `--service status` 明确返回已安装但未加载，exit 1，符合当时维护停止事实。后续完整测试、真实复验和恢复结果见下节。

20:38:33 UTC 复用同一临时 Go 只读程序、同一真实 desktop socket、同样“主任务+fixture”两个 ID：主任务仍记录 `frame-too-large`，fixture 得到 `idle / available / revision=112`，没有中途 unavailable；10 秒父 context 到期后才分别撤销并关闭，返回预期 `context deadline exceeded`。未发送或恢复会话；这证明故障隔离，不代表主任务的超限历史已可读。

### Air 恢复与真实控制台回执

- 主任务独立执行 `node verify.mjs`，exit 0 / PASS 15 checks；Go 全包 race、vet、原生和 Linux amd64 构建，以及真实临时 PG/Go/HTTP/WS/SSE/登录整链均通过。独立 `Isolation -race -count=3` 再次通过（4.285s）。
- 提交 `9514d34f19071b8e7012b32ff442230f3a7e8824`。20:41:34 UTC 全量 PG 排空审计通过后，重建 Go 并用完整原绑定参数安装本项目用户服务；20:41:52 UTC 启动，PID 88147，稳定安装二进制的 `go version -m` 指向该提交、darwin/arm64。`vcs.modified=true` 对应未提交的运维文档，不包含代码差异。
- 香港 Controller/Gateway 没有再次替换或重启。Air 在线，发现 18 个会话。新日志为按目标 `frame-too-large`，不再出现此前每两秒整组 observation disconnected。
- 验收首试在发送前 `ready` 断言得到 `blocked`，exit 1；尚未签发测试链接或提交消息。后续脚本只读等待真实资格，再沿用固定请求，不强行发送。
- 20:45:15 UTC fixture 为 `idle / available`，模型 `gpt-6.1-sol / openai_http / low`，send 为 `ready / desktop-owner`；native `loaded=false / status=notLoaded` 保持真实。
- 正式 HTTPS 签发并兑换一次性链接，Cookie 为 Secure/HttpOnly，`/auth/session` 有效；原桌面历史最新/旧页均为 2 条，historyContext 固定且不重复。
- 固定请求 `release_console_3488d3a_01` 通过 Cookie 会话消息接口提交，命令 `cmd_1063090a-b2f0-48f0-99ee-938620754ead`。相同请求再次调用返回同一 command，没有第二次发送。
- 原生 turn `01a12cb6-7822-71e2-8922-bccb0ecd5bcf` completed，正文精确为 `RELEASE_DESKTOP_ROUTE_VERIFIED_20261012`。相同历史 context 可读取该精确 turn；宿主独立 `read_thread` 确认同 turn、completed、5355ms、同正文。脚本输出 `PRODUCTION_CONSOLE_DESKTOP_ACCEPTANCE_PASS`，finally 登出测试 Cookie。
- 未发送微信测试消息、未调用新 app-server、未修改或重启 Codex App。当时保留 fixture 供下述修正的只读复验，后已完成并归档，见末节。

### 实际多会话可用性回退与重规划

20:43:32 UTC 的全量状态中约九个目标存在原桌面 owner 证据；两条状态订阅每十秒轮转，使多数正常 idle 会话反复 unavailable/checking。隔离与一次真实发送通过不代表这个体验回退可接受，不能把 `9514d34` 当作最终生产交付。

后续合同改为最多 16 条单目标连接、观察器实例共享 2 个大帧处理槽。header 先读并检查 32 MiB，再申请预算；body 分配、读取、JSON 解码、严格身份/revision 校验与状态投影完整持槽，释放后才排队 scalar 事件。初始化握手也受同预算约束；body 读取有 5 秒绝对期限，取消和错误释放预算，不预读或缓存 raw 队列。超限直接拒绝，无需等槽。小于连接上限不做十秒轮转，超过上限仍公平调度。

这不等于整个进程仅占 64 MiB：JSON、内核缓冲、桌面发送端，以及独立 discovery/Snapshot/control/history 池另有开销。两个慢 body 时健康流只能保证有界等待，不保证零延迟。保留 30 秒 Watch 窗重连和 45 秒 TTL，本轮不宣称窗口边界零抖动。该合同的实现和正式复验结果如下。

### 16 连接与共享帧预算交付

- 提交 `058af3dab897ec4a1429157095e860779b7954f9`：最多 16 条单目标订阅，观察器实例共享两个处理槽（同实例并发 Watch 也共用）。整个订阅初始化握手持槽；合法 header 后，body 分配、读取、UTF-8/JSON 解码、严格身份/revision 校验和状态投影均持槽，释放后才发布 scalar，不缓存 raw 帧。body 读取固定 5 秒期限，不因每字节到达延长。header 超限无需等待槽或读取 body。
- 连接尚有余量时，不因已知目标的发现顺序门控驱逐健康订阅；连接用满且存在其他已证明 owner 才轮转。取消会关闭连接并等待 worker 回收，所有退出统一保留 context 取消原因。
- 独立测试先在两连接旧实现稳定复现 9 owner 的 `peak=2 / advanced=[] / lost=true`，再以相同严格断言验证新实现：9 个同时 available，跨三个 slot 收到 revision 2，每目标仅 follow 一次。旧两容量公平反例通过内部覆盖连接上限保留，未放宽断言。
- 新增慢 body 占满双槽时第三帧仅读 header、不分配/read body、期限后健康 patch 恢复；超限 header 不等槽；初始化握手不绕预算；projection 持槽而 scalar 回压不持槽；trickle 不延长期限；同实例两 Watch 共享双槽；取消、错误与 join 后 permit 归零。独立测试发现 scalar 回调等取消后返回 net.ErrClosed 的竞态，修正后连续三轮通过。
- 主任务独立 `go test -race -count=3 ./pkg/codex -run '^TestDesktopSubscription(Isolation|Budget)' -timeout 45s`：PASS 5.809s；新增发现门控空余容量回归 `-race -count=3`：PASS 1.617s。
- 主任务再次执行 `node verify.mjs`：exit 0 / PASS 15 checks，包含全部组件、Go 全包 race（codex 30.621s / client 21.832s）、vet、原生/Linux amd64 构建，以及真实临时 PostgreSQL、Go Daemon、HTTP/WS/SSE/登录/计划恢复整链。所有临时测试容器正常清理。
- 实现单元有一次既有 `TestDesktopFrameLargeSendReadinessSnapshot` 在 3 秒 fixture deadline 超时；发生时多轮 race 同时运行，负载只是候选解释，没有证实根因，也没有放宽 timeout。随后主任务上述独立全量通过，另一次 `go test -race ./pkg/codex ./pkg/client -count=1 -timeout=90s` 自然结束并通过（29.789s / 21.898s）；没有杀测试进程。
- 20:56:08 UTC 全量 PG 只读审计：15 completed / 2 failed，全部命令终态，无有效 claim、待确认、活动执行或未决通知。构建本项目 Go 二进制并用完整原参数安装，20:56:25 UTC 启动 PID 97256。稳定安装版本由 `go version -m` 确认为 `058af3d`、darwin/arm64；`vcs.modified=true` 仅对应未提交文档，生产源码与该提交无 diff。
- 第一次只读采样脚本误用 `sessions[].sessionId` 而接口字段实际为 `id`，32 次全部未匹配、exit 1；该结果不是线上不可用证据。核查接口字段后修正脚本并增加目标缺失即失败断言，没有修改服务来绕过失败。
- 修正采样 20:57:38–20:58:50 UTC，共 30 次，9 个精确健康目标同时 available；最长连续采样全可用为 47,746 ms。native loaded/status 未改写，超限主任务始终 unavailable。20:58:28.524 采到 Watch 边界仅 1 个 available / 0 ready，20:58:30.795 恢复 9/9；20:57:59.676 另采到 ready=8，随后恢复。证明不再每十秒轮流驱逐健康会话，但采样不能证明间隔内从无抖动，也不代替长期压测。脚本 exit 0：`PRODUCTION_NINE_OWNER_CONTINUITY_PASS`。
- 20:58:21 UTC 只读查询原命令 `cmd_1063090a-b2f0-48f0-99ee-938620754ead` 和原 turn `01a12cb6-7822-71e2-8922-bccb0ecd5bcf`：completed、desktop-owner、指定正文一致；同 historyContext 连续读取包含该精确 turn，输出 `PRODUCTION_EXISTING_TURN_READONLY_PASS`。独立宿主 `read_thread` 再次确认 idle、原 turn completed、5355ms 和同正文。没有再次发送标记。
- 20:59:00 UTC 香港 Controller/Gateway 镜像 ID 与切换后记录一致，均 healthy/restartCount=0，启动时间仍为 20:20:32 / 20:20:50 UTC；PG healthy 且未重建。Gateway health ok=true、consecutiveErrors=0、totalErrorCount=0（当前进程），与前述构建期旧进程错误分开记账。新修复仅重载 Air 本项目用户服务，未改或重启 Codex App。
- 专用会话 `01a12a91-5777-75e0-8df3-4ee968565997` 已在确认 idle/精确 turn 完成后归档，可再次复用；临时只读 Go probe 及空目录已删除。两个协作单元均结束，无测试进程或测试容器残留；生产 Daemon、原 PG、token、journal 和 checkpoint 保留。未推送，未运行 GitHub CI。

当前未完成边界：微信真实入站和内置浏览器需用户发送“给我控制台链接”“查看 Mac Air 在线节点和会话”完成；Mini 仅发现不等于可控，未指定终端目标；其他 CLI 的主动控制、超限大会话完整历史、长时休眠断线恢复及完整生产保障均不作完成声明。

建议将“构建不得与小内存生产实例竞争资源，发布必须检查完整在途计划”纳入后续发布规范；本轮仅改项目运维文档，没有修改 CLAUDE.md、rules 或 skills。
