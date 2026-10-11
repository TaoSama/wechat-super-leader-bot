# 本地发布候选产物验收

本地日期：2026-10-12；运行时间为 2026-10-11 23:47–23:53 UTC。源码固定为 `f6b2b5db4e27fe31c562c603d608561c2bbf9748`，不是工作区临时拼装。**仅完成本地产物构建与启动烟测，未推送或更新生产服务，不是全目标完成。**

## 范围与前置

- 相对正式 Controller/Web `a4ef93c`，源码基线包含 7 个后续提交；本次打包终端单步输入、可信记录历史及计划结果传递。功能级整链与浏览器证据沿用 [结果传递验收](../2026-10-12-plan-result-handoff/VERIFICATION.md)，本轮不冒称重新运行全部单测或微信/真实会话验收。
- Gateway 源码、Dockerfile、Compose 相对已发布 `3488d3a` 无变化，未重复构建或重启。最新部署边界见 [验收总表](../2026-10-10-control-plane/ACCEPTANCE.md)。
- 本机 Air / Mac17,3 / arm64；本地 Docker VM 4 CPU / 7922 MiB，构建前 `free -m` 显示 available 5867 MiB，load 0.02/0.09/0.09。已有两个容器 healthy，没有在香港构建或改变 VM/系统配置。
- `docker buildx version` 返回 unknown command。官方固定 v0.38.0 darwin-arm64 仅下载至 `mktemp -d` 创建的临时目录，与官方 `checksums-signed.txt` 对应条目及此前固定 SHA256 一致后才执行：`85989b895add5f119c1ccf8eada2f6892fc33ccf16bd8917638eae404ef26344`。未安装全局插件。

## 构建与产物身份

```sh
git archive f6b2b5db4e27fe31c562c603d608561c2bbf9748 | <temporary-buildx> build \
  --platform linux/amd64 --load -f Dockerfile.controller \
  --label org.opencontainers.image.revision=f6b2b5db4e27fe31c562c603d608561c2bbf9748 \
  -t super-leader-controller:f6b2b5d -

# 以下在 daemon/ 执行，仅生成候选，不安装用户服务
go build -o bin/super-leader-daemon-f6b2b5d-darwin-arm64 .
env GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build \
  -o bin/super-leader-daemon-f6b2b5d-linux-amd64 .
```

三项构建均退出 0。构建上下文是 Git archive，未包含未跟踪的 `.runtime`、生产账号或 journal；Dockerfile 的构建阶段采用本机架构，最终镜像为 linux/amd64。

| 产物 | 实际身份 |
| --- | --- |
| Controller/Web 镜像 | `super-leader-controller:f6b2b5d` |
| 本机 Docker image ID / manifest list | `sha256:1b56007e692e6a0e21d077e5a21dfeec4e4c4c6a32995a3f19c17ed8a9b394a4` |
| 构建输出 config digest | `sha256:b7148c5dcc2dffdd35a28034757f22d9bfd7ec13a48eb5a08f97e2dcaf1d3a0b` |
| 架构 / 运行用户 / revision | linux/amd64 / node / `f6b2b5db4e27fe31c562c603d608561c2bbf9748` |
| Web JS / CSS | `index-DyMTH1BJ.js` / `index-BmkiR_3Q.css` |
| macOS 候选 SHA256 | `f87e43accc0897317a8da1a8c5f83bb3d88365b25d21b2650691b5a0bb9e51e1` |
| Linux 候选 SHA256 | `b3c75f14261503e9b49b768d2c864bd024a10c886125fc22906f03ccf1dc306b` |

两份 Go 产物 `go version -m` 均为 go1.26.4、上述完整 revision、`vcs.modified=false`；分别为 darwin/arm64 和 linux/amd64。稳定安装二进制仍是 `e1a6408`，未被替换。

## 运行时观察

临时驱动启动镜像内真实 `node dist/index.js`，通过 HTTP 访问服务，不直接调用内部函数。只使用随机合成 Bearer、空节点/聊天允许名单、rules 模式；无模型 key、微信账号、桌面 socket 或生产数据库。内存模式使用 `--network none`；PG 模式共享另一个 `--network none` 临时 PostgreSQL 的网络命名空间，仅通过 loopback 通信，没有公网或宿主发布端口。

最终驱动 SHA256：`0e4b09bdae9c76c8c2db9254299da737e203fb3e6df767cfb1aac51d881cb5e3`。以下是实际响应，不把资源文件可读当作浏览器交互验收。

清理后保留在废纸篓的驱动可用于复验内存模式（先核对上述 SHA256 与本机资源；本命令仅启动自清理测试容器）：

```sh
docker run --rm --platform linux/amd64 --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --pids-limit 128 --memory 512m --cpus 0.75 \
  --entrypoint node -i super-leader-controller:f6b2b5d --input-type=module \
  < /Users/luwentao/.Trash/super-leader-release-candidate.piwrs0/controller-smoke.mjs
```

| 访问与探测 | 内存模式 / 临时 PG 模式 |
| --- | --- |
| `/health`、Web `/`、上述 JS/CSS | 均 200；JS 含 `terminal-transcript`、`input-written`、`resultFrom` 合同 |
| 无认证 / 错 Bearer / 正确 Bearer 查询状态 | 401 / 403 / 200；节点、会话、指令、技能为空，计划为 `{items:[],limit:12,hasMore:false,observedAt:…}` |
| 管理接口提交残缺 command | 400，未创建任务 |
| 签发登录链接 | 200；凭据仅在 fragment，期限约 3600 秒 |
| 错 Origin / 正确 Origin 兑换 | 401 / 200；失败兑换没有消耗链接 |
| 同一链接再次兑换 | 401 |
| Cookie 属性 | HttpOnly、Secure、SameSite=Strict、Max-Age=3600 |
| Cookie 查询登录态 / 工作台状态 | 均 200 |
| Cookie 调通用管理写接口 | 401 |
| 跨站 Cookie 调精确会话发送接口 | 403；没有会话发送 |
| 同源 Cookie 读取 SSE | 200，实际收到 `event: status`，随后主动取消流 |
| 退出 / 使用已退出 Cookie 再查登录态 | 200 / 401 |

两次最终驱动均输出 `verdict:PASS`、`runtime:v24.21.0`、`arch:x64`、`uid:1000`、`sessionSends:0`。它们与真实 Controller 子进程均退出 0；Docker inspect 的 `OOMKilled=false`。这是实际 x64 镜像在本机仿真环境的烟测，不是香港原生负载或延迟测试。

临时 PostgreSQL 使用既有 `postgres:16-alpine`（本机 arm64），UID 70，256 MiB 上限；PGDATA 与 socket 目录仅在 tmpfs。`pg_isready` 为 accepting connections。候选 Controller 在 PG 模式完成建表和上述完整接口烟测后，独立 psql 查询确认 `commands` 存在 `input_receipt`、`send_route`、`turn_id` 三列；commands 与 leader_executions 均为 0。没有演练生产旧库升级或复制生产数据。

原生 macOS 候选和容器内 Linux 候选 `--help` 均退出 0，包含新终端参数。实际错误探测：

```text
--probe --terminal-send-mode non-atomic
exit 2: terminal-send-mode must be non-atomic with explicit terminal-sock and terminal-pane

--probe --terminal-history-root claude=<临时目录>/nonexistent
exit 2: terminal-history-root requires explicit terminal-sock and terminal-pane
```

两种缺少明确目标的配置均在连接/运行前拒绝；未安装 Linux 用户服务或接触真实 CLI。

## 保留失败与修正过程

1. 首次临时烟测容器仅设 256 MiB，同时运行 x64 Node 驱动与 Controller，退出 137、无接口结果。Docker events 明确记录同一容器 `oom → die(exitCode=137) → destroy`。尝试只读内核日志被权限拒绝；不由此推测内核细节或声明产品内存泄漏。改用既有生产容器的 512 MiB 限额重跑，仅修改临时测试配置，不改生产或系统配置。
2. 首次 512 MiB 驱动在读取状态后退出 1：脚本错误地断言 `executions === []`，实际返回分页对象。核对 `controller/src/console/executions.ts` 后改为严格验证 items/limit/hasMore/observedAt，没有改产品 DTO 或放宽鉴权断言。该次 Controller 正常退出 0，容器 `OOMKilled=false`。
3. 修正后内存模式与独立临时 PG 模式完整通过。既有两个容器持续 healthy，正式 Air Daemon 仍为原 PID 29300。512 MiB 下这次短烟测通过不构成生产容量、长稳或最小内存保证。

## 切换边界与未完成项

- Controller/Web 必须成对更新；Gateway 无需换版。正式切换需先冻结入口、完整核查在途命令/claim/所有 active 计划，保留 checkpoint；不能用近 50 条命令或最多 12 条计划的界面判断排空。
- 新 Controller/Daemon 对 missing 与明确空 output 的语义不同于旧版；混版本窗口不验收结果传递。按维护窗口更新两端，不能因服务健康就跳过精确回执验证。
- 写入带 `attempt.input` 的结果快照后，旧 Controller strict schema 可能拒绝读取；写入 `input-written` journal 后，旧 Daemon 拒绝该状态。不能直接降级、删记录、换空 journal 或清 claim 来绕过。
- 新二进制包含终端能力不等于授权启用。正式参数仍需逐项保留；新 terminal socket/pane/history-root/send-mode 必须有明确真实目标，不顺带开启。
- 仍未获本次推送与上线确认；未执行 git push、镜像上传、服务安装/切换、真实微信外发或测试会话恢复。Mini owner、公司机器数据边界、Linux 用户服务、真实 CLI 完成证明及微信手机端等完整门槛保持未完成。
- 临时 PG 已用 `docker stop --timeout -1` 正常停止，退出 0。正式镜像、两个候选二进制及必要证据保留，未创建备份。

## 清理

独立 inspect 确认三次保留的烟测容器均为 exited（失败驱动 1、两个最终驱动 0），临时 PG exited/0；四个精确容器随后正常 `docker rm`，未使用 force 或删除正式卷。首次 OOM 容器与 Linux CLI 容器已由各自 `--rm` 清理。`docker ps -a --filter name=super-leader-release` 最终无输出。

临时 buildx、校验文件和驱动所在目录 `/tmp/super-leader-release-candidate.piwrs0` 已通过系统 trash 工具移至废纸篓，原路径不存在；可从 `/Users/luwentao/.Trash/super-leader-release-candidate.piwrs0` 恢复，其中最终驱动可按上文 SHA256 核对。没有留下测试后台进程。最终已有两个本地容器仍 healthy，稳定 Air Daemon 仍为 PID 29300；未触及 Codex App 生命周期。
