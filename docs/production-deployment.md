# 生产部署

`.github/workflows/deploy-production.yml` 监听 `Verify` 的 `workflow_run.completed`。
Verify 保留 PR 的 `opened`、`synchronize`、`reopened` 事件，并监听 `ready_for_review`，
确保草稿阶段的验证已经结束后，转为 ready 仍会启动一次新验证。
`GITHUB_TOKEN` 直接引起的 `push` 和 `pull_request.closed` 不会启动后续工作流；
启用 auto merge 的 token 本身不能证明最终合并事件的来源。
因此部署以 Verify 完成为入口，再通过 GitHub API 核对成功的同仓库 PR 验证、仓库所有者
身份、非草稿、当前 PR head、合并状态和实际 merge SHA。符合条件且仍开放的 PR 沿用
现有 60 次检查、5 秒间隔的轮询窗口（休眠最多 295 秒，API 耗时另计）；即使
`auto_merge` 暂为空，也等待实际合并，避免 Verify 先于自动合并启用时漏发。
未选择自动合并的普通 PR 也会等待至该上限，仍未合并则明确失败。
失败验证、fork、旧 head、非 main 目标、草稿及关闭未合并的 PR 均跳过；等待期间身份
变化也立即跳过。API 错误和等待超时会失败，不会进入生产发布。

保留 `pull_request_target.closed` 作为人工合并入口：即使 CI 通过数小时后才合并，
也会重新查询该 PR head 对应的成功 Verify，再执行相同的合并和当前主干门禁。
机器人合并依赖 `workflow_run`；两个入口重叠时，在串行部署 job 内、构建前读取生产凭据和
实际运行状态，满足完整条件才跳过构建、传输和激活。串行队列本身不提供去重。
两个入口各自覆盖不同合并时序，不能删除其中之一：人工晚合并需要 closed，
由 `GITHUB_TOKEN` 直接执行的合并不能依赖 closed。token 合并若发生在 Verify 轮询
预算结束后，现有两个入口仍存在覆盖缺口，本次去重不改变这项限制。
事件语义依据 [GitHub 官方触发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
和 [事件说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)。

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

重复触发同一版本时，只有成功发布凭据、环境和实际运行配置完整匹配才跳过；
上一版回滚选择保持不变。远端激活内仍会重新核对，避免构建后配置漂移被旧的快速路径漏过。
健康检查失败时，脚本会恢复上一次 `.runtime/release.env` 并尝试重新启动旧镜像，随后
以失败状态结束。首次发布没有可回滚版本；Compose、Docker、SSH、归档校验或旧版本
重启失败都会在对应停止点失败，工作流不会报告部署成功。成功发布后只清理同名仓库中
已被替代的镜像 tag，并保留当前和上一版本供一次回滚使用；临时归档和脚本会清理。
生产容器日志仍由现有的 `json-file` 10 MiB × 3 轮转策略限制。

### 构建前的重复发布判定

`transfer-release.mjs --probe` 在 `deploy-production` job 的并发锁内运行，早于 Buildx、
两镜像构建、manifest 上传和 SCP。远端 `release-state.py` 与脱离 SSH 的激活进程共用
`.runtime/activation.lock`：最多等 60 秒，取得锁后重新读取状态；锁等待、SSH 或 Docker
查询失败都明确失败，不猜测已经部署。检查不调用业务接口，也不加载或修改镜像。

实际激活完成最终健康和镜像验证后，才以 0600 原子写入
`.runtime/deployment-receipt.json`。凭据包含 revision、两服务实际 image ID、配置文件指纹、
release/controller env 摘要及容器 Config、HostConfig、挂载和网络配置摘要；不保存明文环境。
首次 Compose 前固定 controller env 与本次生成的 release env 摘要，激活内 check 及
记录凭据前后再次核对；健康等待期间修改任一 env 会失败并回滚，不能把尚未应用的新 env
与旧容器配置一起接受。服务发现排除 Compose 一次性维护容器。
只有以下条件全部满足，自动事件才输出 `duplicate_skipped` 和 `deploy_required=false`：

- 凭据 revision 与本次已核实的 merge SHA 相同，配置、脚本及 seccomp 文件指纹相同。
- 两份 env 摘要相同，两服务各有唯一、正确项目和部署目录归属的运行容器且健康。
- 实际容器 image ID、当前 tag 的 image ID 与成功凭据相同，平台和 OCI revision 正确。
- 实际容器配置摘要相同，Gateway 仍使用 23 小时窗口。

新版本、首次启用而没有凭据、无效凭据、服务缺失或健康/镜像/配置漂移均进入正常发布，
不能宣称已部署。最终验证或凭据写入失败时不提交新凭据，沿用原回滚流程；旧凭据也必须
重新通过实际状态检查。手动 `workflow_dispatch` 保留构建恢复入口，绕过构建前自动去重；
激活阶段仍只在全部条件匹配时跳过无必要的容器重建。diagnostic-only 入口不受影响。

日志区分 `duplicate_skipped`（构建前跳过）、`activation_skipped`（已传输但激活内跳过）
和 `deployment_verified`（本轮实际激活成功），跳过不会伪报本轮完成了生产激活。
独立验收应观察两个自然事件解析同一 merge SHA，只有首轮出现 build/transfer/activation；
后轮应在 preflight 明确跳过，且容器 ID、StartedAt、实际 image ID 均未变化。
漂移和失败恢复须在隔离环境验收，不能为验证去重而在生产主动重建或发送微信。

代码回退通过新 PR 撤回去重门和凭据写入即可；旧 release 脚本忽略凭据文件。
镜像回滚仍使用 `release.env.previous`；凭据不会替代镜像、数据库或业务状态回滚。
本次不改持久 volume、Controller 运行根、daemon 或微信额度规则。

### 传输观测、取消与 stage 归属

`scripts/deploy/transfer-release.mjs` 使用固定的十一份发布文件清单（包含运行态凭据 helper）。SSH 前将每份文件的
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
远端激活以独立会话在后台运行：`remote-release.sh` 的标准输入接 `/dev/null`，输出写入
stage 内的 `activation.log`，结束后原子写入 `activation.status`。SSH 只负责启动和轮询，
runner 超时、取消或断链不会让 Compose 或回滚因 SIGPIPE/SIGHUP 中途退出。同一 stage
只能启动一次；激活未结束时拒绝清理 stage。同一发布目录同时只允许一个激活：上一次被取消的任务仍在远端运行时，新的发布会等它结束（`activation_waiting`）再启动，等不到就失败且不会启动。wrapper 每 5 秒读取一次状态，读到退出码 0
才继续清理；非零退出码记录 `activation_failed` 并保留 stage 和日志作为证据；等待超时
或取消记录 `activation_completion_unknown`，保留 stage，交由原任务核查。初始清理状态始终为
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
children文件缺失时重新核对同一进程身份：活进程为`children_unavailable`，确认退出为
`process_exited`，PID/starttime/name/group变化为`process_changed`，不推断内核配置原因。

`scp_finished`记录SCP子进程结果、固定错误分类及从启动到结束的耗时，它仍包含SSH建立、
认证和SFTP传输，不能称为纯payload吞吐。随后 `transfer_verified`/`diagnostic_success_case`
增加独立 `verification_elapsed_ms`，表示远端hash校验SSH调用的总耗时。它也包含建连，
不能把这项全算作hash CPU。最终远端状态、完整性、当前main与激活门禁继续严格执行。

以上只补齐下一次同路径传输的证据，不能补回历史runner的TCP状态，也不证明持续慢传已
修复。1MiB有界诊断成功仍不能代替完整镜像传输或生产部署验收。

### 上传前的冻结清单

构建后的current-main检查通过后，`prepare-transfer-manifest.mjs`复用固定发布文件与流式
SHA256规则，生成至runner本次独立临时目录的`transfer-manifest.json`（最多16KiB）。
内容为schema、resolver实际选出的revision M、run R、attempt A、每份文件name/bytes/sha256
及total_bytes；不含端点、凭证或stage owner token，也不加入发布payload。
工作流用固定commit的upload-artifact v4提前发布
`release-transfer-manifest-M-R-A`；上传失败或文件缺失会阻止后续传输步骤。

生产sender要求`--manifest-file`与上传成功返回的`--manifest-artifact-id`。在任何SSH
操作前检查身份、schema、十一个唯一固定名称、安全整数、hash和总量，再重算本地文件核对；
实际包变化立即失败，不重新生成另一份清单继续。这个第二遍hash用于确认冻结后的包未变。
Diagnostic-only仍使用原有有界合成样本。只读 fetch 和 receiver 兼容历史十文件清单，
新 sender 始终要求包含 helper 的十一文件清单，不能用旧包绕过当前发布完整性检查。

取证端在已有只读`GH_TOKEN`的环境中，先定位指定attempt的唯一部署job，再用小入口读取：

```sh
gh api "repos/$DEPLOY_REPO/actions/runs/$DEPLOY_RUN/attempts/$DEPLOY_ATTEMPT/jobs?per_page=100" \
  --jq '.jobs[] | select(.name == "Build and deploy linux/amd64 images") | {id,run_id,run_attempt,name,status,started_at}'
node scripts/deploy/fetch-transfer-manifest.mjs \
  --repository "$DEPLOY_REPO" --revision "$DEPLOY_REVISION" \
  --run-id "$DEPLOY_RUN" --attempt "$DEPLOY_ATTEMPT" --job-id "$DEPLOY_JOB" \
  --output-dir "$OBSERVER_DIRECTORY"
```

这些变量须固定为本次已核对的repository/M/R/A/J，`OBSERVER_DIRECTORY`为父目录已存在的
新绝对目录；不能用Actions run/job的head_sha替代resolver的M。入口核对当前run/attempt、
工作流、唯一job与started_at，以及artifact名称、同run/仓库归属、job起止时间、过期状态。
重名、跨run、过期或超过100条的列表均拒绝；若API提供artifact digest，也核对下载SHA256。

每个HTTP请求最多15秒、总网络期限60秒、API JSON最多2MiB；下载ZIP最多64KiB，使用本地
Python 3标准库只读取唯一的`transfer-manifest.json`成员，拒绝路径、symlink、多成员和
超过16KiB的解压内容，不执行extractall。重新通过共享清单校验后，仅向新目录写入
`transfer-manifest.json`及`observation.json`；后者保存同job的job_started_at和artifact身份。
receiver的`--manifest-json`取前者的files，revision/run/attempt也从同一文件取得，
`--job-started-at`取后者。读取失败保留证据缺口，不从旧包或未结束job日志补猜。

v4 artifact上传完成即可通过API读取，独立于job是否结束；这不等于当前代码已在正式CD
验证。回滚本入口仅撤回runner侧prepare/publish/消费代码，不修改VPS stage或历史状态。

### 接收端只读采样

`scripts/deploy/receiver-telemetry.py`是独立的Python 3.10+只读采样器，供一次已批准发布
通过严格host-key SSH的标准输入执行。正式CD不会自动启动它。运行前须固定实际merge
revision、run、attempt、部署目录、端口、job.started_at以及该run的文件manifest；
使用 `--help` 查看标准参数。manifest必须来自本次构建的真实清单，不能复用旧包大小。
同run清单按上一节的独立artifact入口取得；不依赖未结束job日志下载，也不新增远端清单文件。

采样器只在唯一stage内寻找两份归档的可写文件FD，核对八进制访问模式、普通文件的
device/inode及目录身份，再沿专属SFTP/SSH进程链绑定唯一ESTAB socket。采样前后重查
PID/starttime/PPID、文件FD及socket FD/inode；共享监听器、只读status/verify和采样器
自己的观察SSH不能冒充上传连接。多个writer/socket、归属变化或权限不足均明确
unavailable；无关短会话或已关闭的扫描FD退出不会让另一条有效上传流失效。
目标FD的同一份fdinfo必须可读且同时提供flags与ino；上游Linux自5.14提供该ino字段，
厂商回补或裁剪内核以实际能力为准，缺失时保持unavailable/proc_invalid，不以独立fstat替代读取flags时的身份核验。

接收侧记录bytes_received、Recv-Q、rcv_space/rcv_ssthresh、内核提供的接收memory/buffer/
backlog/drops，以及匹配进程的CPU ticks、wchar/write_bytes/cancelled_write_bytes和宿主
IO压力。缺失字段保留null；VPS发送cwnd不代表上传发送侧。TCP字节、文件长度和缓存
写回计数分别解释，不能据此声称已经持久化到磁盘。

接收端分别查询部署端口的ESTAB连接和LISTEN inode，每条ss查询仍限制1500ms及64KiB，
不读取全主机TCP表；LISTEN结果用于拒绝共享监听器。最多16条候选连接、64个相关PID、
每PID 128个FD、16层进程树。任一ESTAB候选缺少可核验owner时，该样本保持
unavailable/socket_owner_missing；全部候选仍计入16条上限，观测缺口不会中断健康SCP。
首次发现阶段最多60秒按1秒查找，正常样本间隔15秒；
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

## Claude Code 后台执行器

生产 `compose.production.yaml` 默认 `BACKGROUND_EXECUTOR=codex`：后台任务、`kind=background`
的定时任务和 leader 的后台追问/延期工具默认由 Codex 执行。只有在 `.runtime/controller.env`
显式设置 `BACKGROUND_EXECUTOR=claude` 并重新发布后，才改由 Controller 容器内的 `claude -p` 子进程执行。
微信主对话 leader 不受影响，仍使用 Codex Task；`kind=session` 定时任务仍发到创建时冻结的节点会话
（可以是 Codex 会话，也可以是节点上的 Claude Code 会话）。切回 Codex 只需在 `.runtime/controller.env`
删除 `BACKGROUND_EXECUTOR` 或设为 `codex` 后重新发布。

### 启用 Claude 前

选择 Claude 时，Controller 启动只在本地检查 sandbox，不会调用模型网关，所以网关不兼容时健康检查
照样通过，失败要等到第一个后台任务才出现。显式切换到 Claude 前：

1. 确认 Claude 实际使用的网关支持 Anthropic Messages API（`POST /v1/messages`）和对应认证头。凭证从
   `.runtime/controller.env` 读取，经 stdin 交给 curl，不出现在命令行参数和 shell 历史里。`BASE` 是去掉末尾
   `/v1` 的网关地址，`MODEL` 是网关上的 Claude 模型名；使用 `BACKGROUND_CLAUDE_AUTH_TOKEN` 时把头换成
   `Authorization: Bearer`：

   ```sh
   ( set -a; . .runtime/controller.env; set +a
     KEY="${BACKGROUND_CLAUDE_API_KEY:-${BACKGROUND_MODEL_API_KEY:-$LEADER_MODEL_API_KEY}}"
     printf 'header = "x-api-key: %s"\n' "$KEY" | curl -sS -K - -o /dev/null -w '%{http_code}\n' \
       -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' \
       -d "{\"model\":\"$MODEL\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" \
       "$BASE/v1/messages" )
   ```

   返回 `200` 才算兼容。其他结果先在 `.runtime/controller.env` 固定 `BACKGROUND_EXECUTOR=codex`，配好
   `BACKGROUND_CLAUDE_*` 再切换。
2. 在 VPS 上用新的 `deploy/security/codex-apparmor` 覆盖 `/etc/apparmor.d/super-leader-codex` 并执行
   `sudo apparmor_parser -Kr /etc/apparmor.d/super-leader-codex`（见下文「隔离方式」）。

### `.runtime/controller.env` 需要的变量

后台执行仍需 `BACKGROUND_WORKER_ROOT`（例如 `/var/lib/super-leader-runtime/background/workers`），
未设置时整个后台执行关闭。凭证只写在 `.runtime/controller.env`（权限 `600`），不进仓库、不进日志。

| 变量 | 说明 |
|------|------|
| `BACKGROUND_EXECUTOR` | 可选，默认 `codex`；显式设 `claude` 才启用 Claude Code |
| `BACKGROUND_MODEL_BASE_URL` / `BACKGROUND_MODEL_API_KEY` | 已有的后台模型网关。未设置 Claude 专用凭证时，Claude 复用这对值：URL 作为 `ANTHROPIC_BASE_URL`，key 作为 `ANTHROPIC_API_KEY`（`x-api-key` 头）。两者都未设置时继续回退到 `LEADER_MODEL_*` |
| `BACKGROUND_CLAUDE_BASE_URL` | 可选，覆盖 Anthropic 兼容端点。末尾的 `/v1` 会被去掉，因为 Claude Code 会自己拼 `/v1/messages`；必须是 `http(s)`，不能带用户名、密码、query 或 fragment |
| `BACKGROUND_CLAUDE_API_KEY` | 可选，以 `ANTHROPIC_API_KEY`（`x-api-key`）发送 |
| `BACKGROUND_CLAUDE_AUTH_TOKEN` | 可选，以 `ANTHROPIC_AUTH_TOKEN`（`Authorization: Bearer`）发送；网关要求 Bearer 认证时用它 |
| `BACKGROUND_CLAUDE_OAUTH_TOKEN` | 可选，`claude setup-token` 生成的订阅 token，以 `CLAUDE_CODE_OAUTH_TOKEN` 发送；服务端自动化使用受 Anthropic 消费者条款约束，生产优先用 API key |
| `BACKGROUND_CLAUDE_MODEL` | 可选，网关暴露的 Claude 模型名：别名 `sonnet` / `opus` / `haiku`，或 `claude-*`（允许 `vendor/claude-*` 前缀和 `[1m]` 后缀）；未设置时使用 CLI 默认模型 |
| `BACKGROUND_CLAUDE_PATH` | 可选，默认镜像内的 `claude` |

三个 `BACKGROUND_CLAUDE_*` 凭证最多设一个，同时设置多个时 Controller 拒绝启动。设置了 Claude 专用凭证时，
不会继承 `BACKGROUND_MODEL_BASE_URL`：没有 `BACKGROUND_CLAUDE_BASE_URL` 就发往 Anthropic 官方 API，
避免把专用凭证发给别的端点。控制台「后台任务」模型设置在 Claude 下显示 `Claude Code CLI` 和 Claude
模型别名；选中的 Claude 模型和推理强度作用于后续轮次，之前为 Codex 保存的模型不会传给 Claude。
反过来也一样：切回 `codex` 后，为 Claude 保存的模型和推理强度不会传给 Codex，后台任务使用
`BACKGROUND_MODEL_NAME`，直到在控制台重新保存 Codex 模型。

长结果的微信摘要仍由 `BACKGROUND_MODEL_*`（缺省回退 `LEADER_MODEL_*`）这组 HTTP 模型生成，与执行器无关；
Claude 执行器下也保留这组配置，否则 `LEADER_MODE=rules` 时长结果会停在 `summary_generation_failed`。

### 隔离方式

Claude 作为 Controller 子进程运行在同一个加固容器里（只读根文件系统、UID 1000、`cap_drop: ALL`、
`no-new-privileges`、seccomp 与 `super-leader-codex` AppArmor）。镜像固定安装
`@anthropic-ai/claude-code@2.1.311`、`bubblewrap` 和 `socat`。Codex 0.163.0 会优先使用 `PATH` 上的
`bwrap`，换成 Debian 的 bubblewrap 后 Codex 自己的 sandbox 起不来，后台任务每轮都以
`worker_execution_unverified` 失败；所以镜像用 `dpkg-divert` 把 `bwrap` 移到
`/usr/libexec/claude-sandbox/bwrap`，Codex 继续用自带的 bwrap，Claude Code 通过
`/etc/claude-code/managed-settings.json` 的 `sandbox.bwrapPath` 找到它（这个键只认管理员设置）。
每轮的 `--settings` 包括：

- `sandbox.enabled`、`failIfUnavailable: true`、`allowUnsandboxedCommands: false`：sandbox 起不来时
  CLI 直接失败，Bash 永远不会在 sandbox 外执行。`enableWeakerNestedSandbox: false`：bubblewrap 在新
  PID 命名空间里挂载新的 `/proc`，看不到 Controller 和 CLI 进程的 `/proc/<pid>/environ`。
- 文件工具 `blockReadsOutsideWorkingDirectories`，Read/Edit 只允许工作区；Read/Edit 拒绝 worker home、
  artifact root、`/etc/super-leader`、`/proc`。
- Bash 的 `filesystem.denyRead` 覆盖整个 `CONTROLLER_DATA_ROOT`、artifact root 和 `/tmp/*`，只用
  `allowRead` 重新打开本 worker 的工作区和本轮临时目录 `/tmp/slc-<id>`（`TMPDIR` 与
  `CLAUDE_CODE_TMPDIR` 都指向它，轮次结束即删除）。其他 worker、设置目录和 Controller 的临时文件不可读，
  `/tmp` 下已有文件也不可覆盖。临时目录路径保持在 CLI 的 44 字节上限内，否则 CLI 会让 Bash 回退到共享的
  `/tmp/claude-<uid>`。
- 网络经 sandbox 代理，允许公网，和 Codex worker 的 shell 一样。代理按主机名和 IP 字面量匹配，不支持网段，
  而 `allowedDomains: ["*"]` 也放行 IP 字面量，所以 `deniedDomains` 每轮动态生成：Compose 服务名和容器名
  （`postgres`、`controller`、`gateway`、`super-leader-postgres-1`、`super-leader-controller-1`、
  `super-leader-gateway`），这些名字当前解析到的 IP，Controller 容器自己的全部地址（Controller API 和代理在
  同一网络命名空间），`localhost`、`127.0.0.1`、`0.0.0.0`、`[::1]` 和常见云元数据地址。WebFetch 在 sandbox
  外运行、不受 `sandbox.network` 约束，所以同一份列表也作为 `WebFetch(domain:…)` 拒绝规则。仍然挡不住的：
  `127.0.0.2` 这类其他回环地址或十进制等其他 IP 写法、同一 Compose 网络上新增且未列出的容器 IP。这些服务仍各自
  要求凭证（Postgres 密码和 Controller/Gateway token 都不在 worker 环境里），这里只是纵深防御。
- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`：Bash 子进程环境里没有 Anthropic 凭证。

Compose 为 Controller 额外设置 `systempaths=unconfined`，否则 Docker 屏蔽的 `/proc` 路径会让 bubblewrap
无法挂载新的 `/proc`。这个选项作用于整个 Controller 容器（回滚到 `codex` 后仍然生效），会去掉 Docker 对
`/proc`、`/sys` 的屏蔽和只读挂载；Codex 的 bwrap 也因此在自己的 PID 命名空间里挂载新的 `/proc`，只能看到
sandbox 内的进程。`super-leader-codex` AppArmor 补上被去掉的屏蔽：拒绝 `kcore`、`sysrq-trigger`、
`interrupts`、`keys`、`latency_stats`、`sched_debug`、`timer_list`、`timer_stats`、`acpi`、`asound`、`scsi`
的访问，拒绝 `/proc`、`/proc/sys` 写入和 `/sys/firmware`。容器以 UID 1000、`cap_drop: ALL` 运行，
`/proc/sys` 本来也写不进去。seccomp 只新增三条精确匹配：`clone` 标志 `0x30020011` / `0x70020011`
（bubblewrap 不隔离 IPC）和 `unshare(CLONE_NEWPID|CLONE_NEWNS)`（apply-seccomp 在自己创建的 user
namespace 内）。AppArmor profile 新增了上述读拒绝，VPS 上的 `/etc/apparmor.d/super-leader-codex` 需要
更新并用 `apparmor_parser -Kr` 重新加载；未重新加载时这些内核信息文件可读，其余隔离不受影响。

Controller 启动时先运行 `claude sandbox status` 校验设置已生效且是严格模式，Linux 上再用 `bwrap` 试建
user、PID、network 命名空间并挂载 `/proc`；任一步失败就拒绝启动，不接受后台任务。

### 升级执行器时的已有 worker

每个后台 worker 记录执行器（`executorKind`），每次启动新一轮时更新为当前执行器；会话续接 ID 也带上执行器类型。
切换执行器后，旧 worker 的 Codex 线程不会被传给 `claude --resume`，下一轮会开启新的 Claude 会话，控制台
标签随之变成 Claude Code。切换前创建、之后再没跑过新一轮的执行记录显示「执行器未记录」。

### 镜像内验证

升级 Claude Code 版本、Docker、内核或修改 seccomp/AppArmor/compose 安全选项后，在本地构建镜像并运行：

```sh
docker build -f deploy/Dockerfile.controller -t super-leader-controller:claude-verify .
node tests/integration/leader/claude-worker-container.mjs --run
```

它在生产同等加固参数下用真实 CLI 和容器内的模拟 Anthropic API 跑两轮任务，验证 sandbox 启动、凭证不在
Bash 环境和任何 `/proc/<pid>/environ` 中、其他 worker 与设置目录不可读、`unshare -U` 被拒绝、强制走代理时
`127.0.0.1`、`localhost`、`0.0.0.0`、容器自身 IP 和 `super-leader-gateway` 都返回 403、WebFetch 访问回环地址
被拒、被 Docker 屏蔽的内核信息文件不可读、续接同一会话、清理临时目录；并验证去掉 `systempaths=unconfined`
或去掉三条 seccomp 规则时 Controller 拒绝启动。Codex 执行器（回滚路径）用同一镜像验证：

```sh
node tests/integration/leader/background-worker-container.mjs --run --native-only --image super-leader-controller:claude-verify
```

它同样带 `systempaths=unconfined` 运行，确认 Codex sandbox 能启动，且任何可读的 `/proc/<pid>/environ`
里都没有 Controller 环境和 provider key。
没有 AppArmor 的引擎（Docker Desktop）可加 `--skip-apparmor`，但不能作为生产证据。

## 节点启用 Claude Code 会话

Daemon 默认不读取 Claude Code 会话。节点上启用时由运维在合并后手工重装服务，注意两点：

- `--service install` 只按本次命令的参数重建 launchd plist，**没有重新传入的参数会被丢弃**。
- launchd 环境的 `PATH` 不含 `~/.local/bin`，必须显式传 `--claude-path`，否则参数校验失败，
  KeepAlive 会反复重启 Daemon，连 Codex 会话也会离线。

以 macmini 为例（macair 换成对应用户目录），以登录用户身份执行，不要用 root：

```sh
# 1. 备份并读出当前参数
cp ~/Library/LaunchAgents/site.taoai.super-leader-daemon.plist ~/super-leader-daemon.plist.bak
plutil -extract ProgramArguments json -o - ~/Library/LaunchAgents/site.taoai.super-leader-daemon.plist

# 2. 用包含 daemon/pkg/claude 的提交构建 Daemon，先前台试跑一次（同样参数，不带 --service）
#    确认没有参数错误后 Ctrl-C
./super-leader-daemon <第 1 步除 argv[0] 外的全部参数> \
  --claude-projects-root /Users/macmini/.claude/projects \
  --claude-path /Users/macmini/.local/bin/claude

# 3. 用同样参数重装服务；--token-file 指向已有的 <state-dir>/service-node-token，token 不进 argv
./super-leader-daemon <同上全部参数> \
  --claude-projects-root /Users/macmini/.claude/projects \
  --claude-path /Users/macmini/.local/bin/claude \
  --service install

# 4. 核对
plutil -extract ProgramArguments json -o - ~/Library/LaunchAgents/site.taoai.super-leader-daemon.plist
./super-leader-daemon --service status
tail -n 50 <state-dir>/daemon.stderr.log
```

`--claude-permission-mode` 默认 `dontAsk`，安装时会写入 plist。完成后控制台的节点会话列表应出现带
「Claude Code」标签的 `claude:` 会话。安装中途失败时服务保持停止，用备份的 plist 或修正后的命令重装。
Claude Code 会话通过登录钥匙串取凭证，用户未登录或 token 过期时发送会失败；续写的 Bash 命令使用 launchd
的最小 `PATH`。
