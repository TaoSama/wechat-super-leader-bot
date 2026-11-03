# 生产部署

`.github/workflows/deploy-production.yml` 监听 `Verify` 的 `workflow_run.completed`。
`GITHUB_TOKEN` 自动合并产生的 `push` 和 `pull_request.closed` 都不会启动后续工作流，
因此部署以 Verify 完成为入口，再通过 GitHub API 核对成功的同仓库 PR 验证、仓库所有者
身份、非草稿、当前 PR head、合并状态和实际 merge SHA。自动合并尚未结束时最多等待
5 分钟；未合并且没有开启自动合并的 PR、失败验证、fork、旧 head、非 main 目标均跳过。
API 错误和等待超时会失败，不会进入生产发布。

保留 `pull_request_target.closed` 作为人工合并入口：即使 CI 通过数小时后才合并，
也会重新查询该 PR head 对应的成功 Verify，再执行相同的合并和当前主干门禁。
机器人合并依赖 `workflow_run`，两个入口偶尔重叠时由串行队列和远端幂等检查去重。

实际合并 SHA 必须仍是当前 main。发布 job 使用 `deploy-production` 并发组和
`queue: max`，串行处理、最多保留 100 个待发布 job，不取消正在执行的发布。
排队后、镜像构建后和远端激活前都会重新检查 main；版本被更新时拒绝发布旧 SHA。
只检出主干上的可信门禁脚本和核实后的合并提交，不执行 PR head 或使用 PR artifacts。
`workflow_dispatch` 保留为人工恢复入口，且只接受调用时的当前 main revision。

手动入口的 `diagnostic_only` 默认关闭。开启时只运行独立的 diagnostic-only job，
resolve 和正式发布 job 均跳过。诊断只检出可信 main，再核对调用 revision 仍为当前 main；
与正式发布共享串行并发组。它使用 `environment: {name: production, deployment: false}`
读取既有环境 secrets/vars，不创建 deployment 对象、不更新生产部署历史。
required reviewers 和 wait timer 仍然生效；若环境以后配置 custom protection app，
GitHub 会因其与 `deployment: false` 不兼容而拒绝运行，不应删除保护规则绕过。
诊断结果只表示 SSH/SFTP 诊断是否通过，上线仍须核对实际生产 runtime revision。

工作流在一个 Ubuntu runner 中并行构建 Controller 和 Gateway 的 `linux/amd64`
Docker 归档。两个归档都带有完整 commit SHA 的 `org.opencontainers.image.revision`
标签，并在传输前检查平台、revision 和 SHA-256。归档通过固定 `known_hosts` 的 SSH
连接复制到 VPS，再由 `scripts/deploy/remote-release.sh` 完成以下顺序：

1. 只读检查 Docker、Compose、生产 env 文件、Compose 配置和现有安全策略。
2. 校验归档 SHA-256，加载镜像，并再次检查平台和 OCI revision。
3. 用 `deploy/compose.release.yaml` 给现有 `compose.yaml`、生产和 Gateway overlay
   注入不可变镜像名；不创建新 volume，也不执行 `down`。
4. 以 `--no-build --force-recreate` 重新创建 Controller/Gateway，等待两个健康检查
   成功，再检查运行状态、镜像和 revision。数据库、Controller runtime、微信账号和
   Gateway 状态路径由现有 Compose 配置继续管理。

重复触发同一版本时，只有 release env 完全一致、Controller/Gateway 的实际镜像 ID 和
revision 一致、容器健康、Gateway 窗口正确才跳过重建；上一版回滚选择保持不变。
健康检查失败时，脚本会恢复上一次 `.runtime/release.env` 并尝试重新启动旧镜像，随后
以失败状态结束。首次发布没有可回滚版本；Compose、Docker、SSH、归档校验或旧版本
重启失败都会在对应停止点失败，工作流不会报告部署成功。成功发布后只清理同名仓库中
已被替代的镜像 tag，并保留当前和上一版本供一次回滚使用；临时归档和脚本会清理。
生产容器日志仍由现有的 `json-file` 10 MiB × 3 轮转策略限制。

### 传输观测、取消与 stage 归属

`scripts/deploy/transfer-release.mjs` 使用固定的十份发布文件清单。SSH 前将每份文件的
basename、准确 bytes、SHA-256、总字节数及 revision/run/attempt 直接写入 Actions 日志；
传输期间约每 15 秒记录远端已收字节、耗时和平均速率。远端文件长度/hash 再次核验通过后，
重新检查当前 main，随后才调用原来的 release 脚本。20 分钟发布 job 总预算保持不变。
生产传输的周期采样遇到 DNS、超时、连接建立或连接中断错误时，记录固定分类的
`transfer_progress_unavailable` 并继续传输及后续采样；归属、完整性、认证等其他错误仍停止。
诊断模式的采样和生产传完后的最终状态/hash 校验均保持严格失败，不能绕过激活门禁。

每次 stage 为 `.runtime/releases/<revision>-<run>-<attempt>`，原子创建并写入随机归属标记。
已有同名目录会拒绝覆盖。清理必须匹配归属标记，只移除固定发布文件及 release 脚本生成的
`release.env.next`；发现额外文件时保留额外文件和标记，并记录清理未确认。
传输失败、校验失败或最终 main 门禁失败均非零退出，不能进入激活。

SIGINT/SIGTERM 会终止并等待本地 SSH/SCP 进程组，必要时有界升级到 SIGKILL。
若逃逸后代仍持有输出管道，停止失败会受控返回 `process_stop`；保留未确认的子进程记录，
不删除远端 stage，也不声称清理完成。
Actions 的传输 step 使用 `exec node` 替换入口 bash，因此发送到入口 PID 的信号直接
交给 Node。Node 在唯一的自有临时目录中以 0600 创建凭证文件，等待传输停止及远端清理
结束后才删除；入口 shell 不使用可能提前删 key 的 EXIT trap。构建后版本检查单独执行，
取消该检查后不会启动后续传输 step。
进入远端激活后，本地 SSH 退出或断链不能证明远端 release/Compose 已停止；只有 SSH
明确返回成功、确认远端命令已完成后，wrapper 才可继续清理。激活中的取消/断链会保留
stage，记录 `activation_completion_unknown`，交由原任务核查。初始清理状态始终为
`unconfirmed`，只有实际完成归属校验和删除后才记录 `confirmed`。
SIGKILL、runner 丢失或网络不可达可能阻止日志和清理；不能据此声称已经清理。
普通清理最多 8 秒，其中连接最多 5 秒；诊断会按剩余期限缩短连接/执行预算，另外保留
2 秒进程终止宽限。剩余时间不足以完成最小连接和执行时直接记录清理未确认。

工具 stdout/stderr 仅在有大小上限的内部缓冲中处理，日志只输出固定 schema 和错误分类，
不回显连接目标、命令、私钥、token 或原始 SSH 错误。保留现有严格 host key 校验。
事后 artifact 上传包含 cancelled 情况，但只是 best effort；关键证据依赖运行中日志。

### 上传端被动指标与阶段耗时

传输启动约1秒后首次记录 `sender_telemetry`，之后约每15秒采样；它与远端文件长度采样
独立执行，避免一次慢状态查询阻塞上传端取证。Linux下先确认SCP进程组，再从直接SSH
子进程的 `/proc` 身份、starttime、socket FD与 `ss` 所属PID绑定实际上传连接，避免把
周期status的另一条SSH连接混入。确认过的组PID/SSH PID/FD用于本次runner内关联，不输出
地址、端口、命令、环境、私钥或原始工具输出；进程退出、PID重用、多个候选socket均明确
记录不可用，不能把不同连接的指标合并。

固定字段包括发送侧 `rtt_ms`/`rtt_variance_ms`、独立 `min_rtt_ms`、cwnd、发送/确认/重传
字节、重传计数、发送窗口及接收窗口受限时间。`rtt_variance_ms`记录内核rttvar的平均偏差，
单位为毫秒，不是统计方差。RTT按完整token解析，不把 `minrtt` 或
`rcv_rtt` 当作平滑RTT。未出现的字段为null，和内核实际报告零有区别。这些指标来自runner
向VPS发送的socket，不能用VPS的发送侧cwnd替代。SCP/SSH CPU以原始user/system ticks记录，
不假设每秒tick数；`rchar`含缓存/管道读取，`read_bytes`受page cache/readahead影响，均不是
文件传输进度。`io_pressure`是runner宿主的I/O压力上下文，不能归属于某一进程或磁盘。

每次 `ss` 查询使用既有进程管理器，1500ms查询时限，沿用原1秒TERM/1秒KILL停止宽限及
64KiB输出上限。查询失败、缺工具、权限不足、非Linux或进程已结束均输出固定分类的
unavailable；可选观测失败不会取消SCP。SCP结束/取消时停止并等待观测器；若辅助进程停止
仍未确认，传输阶段以 `process_stop` 失败，禁止进入校验和激活；保留children记录并报告
清理未确认，不会删除仍可能被使用的stage或虚报清理成功。

`scp_finished`记录SCP子进程结果、固定错误分类及从启动到结束的耗时，它仍包含SSH建立、
认证和SFTP传输，不能称为纯payload吞吐。随后 `transfer_verified`/`diagnostic_success_case`
增加独立 `verification_elapsed_ms`，表示远端hash校验SSH调用的总耗时。它也包含建连，
不能把这项全算作hash CPU。最终远端状态、完整性、当前main与激活门禁继续严格执行。

以上只补齐下一次同路径传输的证据，不能补回历史runner的TCP状态，也不证明持续慢传已
修复。1MiB有界诊断成功仍不能代替完整镜像传输或生产部署验收。

### 接收端只读采样

`scripts/deploy/receiver-telemetry.py`是独立的Python 3.10+只读采样器，供一次已批准发布
通过严格host-key SSH的标准输入执行。正式CD不会自动启动它。运行前须固定实际merge
revision、run、attempt、部署目录、端口、job.started_at以及该run的十份文件manifest；
使用 `--help` 查看标准参数。manifest必须来自本次构建的真实清单，不能复用旧包大小。
当前完整清单仅输出到sender的`transfer_manifest`日志，尚无独立的实时清单发布入口；
不能假设未结束job的日志下载可用。正式取证前必须验证同run清单的读取方式，否则接收端
准备仍不完整；本改动未新增artifact或远端清单文件。

采样器只在唯一stage内寻找两份归档的可写文件FD，核对八进制访问模式、普通文件的
device/inode及目录身份，再沿专属SFTP/SSH进程链绑定唯一ESTAB socket。采样前后重查
PID/starttime/PPID、文件FD及socket FD/inode；共享监听器、只读status/verify和采样器
自己的观察SSH不能冒充上传连接。多个writer/socket、归属变化或权限不足均明确
unavailable；无关短会话或已关闭的扫描FD退出不会让另一条有效上传流失效。

接收侧记录bytes_received、Recv-Q、rcv_space/rcv_ssthresh、内核提供的接收memory/buffer/
backlog/drops，以及匹配进程的CPU ticks、wchar/write_bytes/cancelled_write_bytes和宿主
IO压力。缺失字段保留null；VPS发送cwnd不代表上传发送侧。TCP字节、文件长度和缓存
写回计数分别解释，不能据此声称已经持久化到磁盘。

每次ss查询上限1500ms、stdout/stderr合计64KiB；最多16条候选连接、64个相关PID、
每PID 128个FD、16层进程树。首次发现阶段最多60秒按1秒查找，正常样本间隔15秒；
日志最多128条、2MiB。期限取job.started_at后20分钟与可选更短期限的较早值；SIGINT/
SIGTERM及期限结束只停止采样器自己的helper。TERM/KILL各1秒宽限；只有helper组结束且
两条输出管道均EOF才确认清理。逃逸后代仍持管道时保留记录、非零退出并报告unconfirmed。
若文件读取或输出阻塞，独立watchdog在停止请求后最多另6秒强制非零退出；输出完全阻塞
时可能没有最终JSON，必须保留清理证据缺口，不能按缺失的日志宣称confirmed。

该程序不删除stage、不发起上传、不取消CD、不调用Docker/Compose或回滚，也不改配置。
下一次真实发布仍须另行确认取证准备和取消预算，收到取消请求不等于已经停止或未激活。
隔离回归覆盖较新OpenSSH internal-sftp和Ubuntu 22.04的OpenSSH 8.9外部sftp-server，
使用独立合成密钥与限速文件；本地fixture按需要获得SYS_PTRACE以读取其自有sshd进程，
不放宽生产权限。标准Verify integration-core复用现有发布传输入口执行这些检查。
8.9隔离客户端显式启用SFTP并省略其不支持的现代SCP参数；较新客户端回归保留这些参数。

### Diagnostic-only 验证边界

诊断只生成一份 1 MiB 成功样本和一份 256 KiB 限速取消样本，整个运行的文件 payload
合计 1.25 MiB，硬上限 2 MiB，无重传重试（SSH/TCP 协议开销不计入文件 payload）。
只进行一组成功与取消验证：成功样本核对长度/hash，取消样本须实际部分写入后停止，
并检查子进程结束、写入停止及自有 stage 清理。传输、验证和取消共用 60 秒期限，
在第 50 秒中止业务操作，为有界停止及清理预留时间。未确认的情况均失败退出。
诊断不会读取生产业务数据，也不调用 Docker load、Compose 或 remote-release。
它不能证明完整镜像传输已恢复吞吐，更不能充当生产发布验收。

不连接生产的可复现验证：

```sh
node --test tests/unit/deploy/transfer.test.mjs tests/unit/deploy/production-cd.test.mjs
node tests/integration/deploy/release-transfer.mjs --run
```

后者创建独立 Docker SSH/SFTP 服务，使用合成密钥和文件，覆盖两种取消信号、
Actions 实际 bash wrapper 的入口信号、凭证在远端清理完成后才移除、远端继续激活时
保留 stage、真实认证失败、完整性失败、外来 stage 和额外文件保护；结束时
清理自建容器、镜像及临时文件，不创建持久 volume。Verify integration-core 会运行它。

镜像回滚仍由原 release 脚本执行：恢复旧镜像选择不等于撤销本轮 staged Compose 路由配置。
本改动不改变路由、业务代码、Controller runtime 根目录或任何生产 volume。

VPS 的 `DEPLOY_PATH` 只需要提供现有的 Compose 项目目录；每次发布会把与镜像相同
revision 的 `compose.yaml`、生产/Gateway overlay 和 seccomp 策略随发布包传输并校验，
因此不会复用旧的声明式配置。首次启用前，在该目录创建权限不向组和其他用户
开放的 `.runtime/controller.env`，并准备已有的微信账号文件、状态目录和
`super-leader-codex` AppArmor profile。工作流不会读取、打印或上传这些运行时密钥。

Gateway 在单实例的持久状态中维护账号共享发送账本；不同任务、业务会话和收件人合计使用 10 次额度。`context_token` 和窗口仍按实际收件人保存，其他收件人的新消息不能续活过期 token。升级会保守迁移旧的分聊天账本，不额外补发额度；下一条有效新入站正常刷新。

Gateway 默认使用 23 小时回复窗口（`GATEWAY_CONTEXT_WINDOW_MS=82800000`）。存在任务或可恢复的待发内容时，在最后 1 小时且至少还有 1 次有效额度时发送续期提醒，剩余额度较多也会提醒；完整计算和优先级见 [README](../README.md#微信回复窗口与提醒)。发布脚本会把窗口值写入不可变的 release env，并在容器健康检查后读取实际容器环境核对；生产环境文件中的旧值不会覆盖本次发布。回滚使用上一份 release env，恢复上一版本的窗口配置。

同仓库且由仓库所有者创建的非草稿 Pull Request 会由
`.github/workflows/enable-auto-merge.yml` 自动开启 squash merge；工作流不检出或执行
Pull Request 代码。`main` 的保护规则应要求 Ubuntu unit/integration 验证和 macOS 15
验证通过。Verify 完成事件经过合并门禁后触发生产部署；部署成功必须同时核对合并 revision、
容器健康状态、`gateway_context_window_ms=82800000` 和 `deployment verified`。

首次引入监听器时，工作流必须先存在于默认分支才会接收 `workflow_run`。安装该监听器
的 PR 可能已经完成 Verify 才合并，不能假设它会自动部署自己。此时应分别记录修复合并、
人工恢复发布和之后正常 PR 合并触发的自动发布；人工 dispatch 或重跑旧 CI 不能作为
正常自动合并链路已验收的证据。工作流事件应为 `workflow_run`，门禁日志中的源 Verify
run、PR head、merge SHA 应与生产镜像 revision 一致。

回退部署触发逻辑应通过新 PR 恢复配置，并保留必要的人工发布入口。运行时发布失败沿用
上一版本镜像回滚，不执行数据库迁移或修改持久化布局。main 若在最后一次版本检查后、
远端激活过程中更新，当前发布可能短暂落后；全局串行队列随后处理新版本，旧版本不会
在一个已经完成的新版本发布之后反向覆盖它。排队超过 100 个 job 时需人工处理取消的发布。

在 GitHub `production` Environment 中配置以下 **Secrets**：

- `DEPLOY_HOST`
- `DEPLOY_USER`
- `DEPLOY_PORT`（可选，默认 `22`）
- `DEPLOY_SSH_PRIVATE_KEY`
- `DEPLOY_KNOWN_HOSTS`

配置以下 **Variables**：

- `DEPLOY_PATH`
- `DEPLOY_ENV_FILE`（可选，默认 `.runtime/controller.env`）
- `DEPLOY_URL`（可选，仅用于 Environment 页面链接）

建议为 `production` Environment 配置 required reviewers，并限制允许部署的分支为
`main`。本地只读检查可运行：

```sh
actionlint .github/workflows/deploy-production.yml .github/workflows/verify.yml
bash -n scripts/deploy/remote-release.sh
docker-compose --env-file /dev/null --profile wechat \
  -f compose.yaml -f deploy/compose.production.yaml \
  -f deploy/compose.gateway.yaml -f deploy/compose.release.yaml \
  --env-file .runtime/controller.env config --quiet
```

旧版 actionlint（如 1.7.12）尚未识别 GitHub 新增的 `concurrency.queue`；可针对这一项
使用 `-ignore 'unexpected key "queue"'` 检查其余规则，并以 GitHub 实际工作流解析为准。
