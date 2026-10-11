# 验证记录

## 环境与范围

2026-10-10，Mac Air (`Mac.lan`)。保留旧 Python 实现、扫码凭证和已有会话。禁止将独立启动的 app-server 或历史 resume 当作原有会话控制成功。

## 已取得的证据

- `uv run pytest -q`：614 passed in 8.17s。此项仅是旧实现的回归，不代表 完成。
- 现有 Unix socket 独立只读探测：`initialize` → `initialized` → `thread/loaded/list` 成功。返回一个已加载会话，`thread/read(includeTurns=false)` 返回标题「明确任务需求」、`status.type=idle`、`source=vscode`。没有执行 resume、turn/start 或启动替代服务。
- `POSTGRES_PASSWORD=validation-only CONTROLLER_TOKEN=validation-only NODE_TOKENS='{"macair":"validation-only-node"}' docker-compose -f compose.yaml config --quiet`：通过；没有启动服务、测试占位值没有用作运行凭证。
- `node --check test-integration.mjs` 与 `node check-control-plane.mjs --help`：通过。只验证脚本语法/入口，尚不代表联调通过。
- Controller `pnpm run build`：首轮通过。
- `node test-integration.mjs`：首轮失败于最后的重启幂等断言（`Restart lost idempotency`，响应缺少原 commandId）。此前 HTTP 鉴权、chat allowlist、真实 PostgreSQL 并发创建去重、accepted 状态与断连 uncertain 断言均通过。已通知实现者修正离线节点上的历史请求查询顺序；测试自行停止并清理本次临时数据库容器，没有影响原有服务。

## 环境问题与处理

- `node test-integration.mjs` 修复后复跑通过：真实 PostgreSQL、HTTP 鉴权、允许名单、WebSocket 注册、并发请求去重、accepted 与 completed 区分、断线 uncertain、Controller 重启恢复。
- `go test -race ./... && go vet ./... && go build -o bin/super-leader-daemon .` 通过（主代理独立执行）。
- `node test-integration.mjs --live --session 01a12176-6082-7150-a791-52a5f3c78c53` 通过：真实 Go Daemon → 临时 PostgreSQL Controller → 现有会话读取与去重，读取输出 4389 字节；没有发送 prompt。
- `node local.mjs --up` 首轮因 pnpm 拒绝未批准 esbuild 构建失败。Dockerfile 显式复制项目内 allowBuilds 配置后重试通过；没有修改系统设置。
- `node local.mjs --check`：macair connected=true，18 条会话记录（含只读历史记录，不能视为 18 个可控制会话）；`GET /health` 返回 ok。部署端口为 127.0.0.1:8790。
- 已清理首次失败构建留下的停止容器 afda3397945c；该容器仅为可重建依赖安装产物，无业务数据。
- 浏览器实测：鉴权输入仅在内存、错误显示与恢复、空状态、375px 无横向溢出、清除凭证通过。两次截图因 CDP 超时失败，未取得视觉截图证据；本次临时浏览器 TaskSpace 和预览进程已关闭。
- Web 曾有 1 项旧文案断言失败（accepted）；Gateway 测试曾因测试文件第 113 行语法错误、错误文案更新未同步断言而失败。均已修正，最终复跑通过（见下）。
- Gateway 子任务出现 high-demand 与 HTTP 524 临时服务错误、Web 子任务出现 high-demand，均在原任务重试。

- 本机 `docker compose` 子命令不可用，但已安装独立 `docker-compose` 5.5.1，使用后者，不修改全局 Docker 配置。
- Daemon 子任务遭遇一次模型服务 high-demand 临时错误，已在原子任务上重试，未重复创建实现。

## 最终复核（本次运行）

- Controller：`pnpm test && pnpm run typecheck && pnpm run build`，26 项测试通过，类型检查及构建通过。覆盖明确目标、错误节点、重复会话 ID、正文中会话名不影响路由、上下文澄清。
- Web：`pnpm test && pnpm run typecheck && pnpm run build`，6 项测试、类型检查、构建通过。
- Gateway：`pnpm test && pnpm run build`，14 项测试与构建通过。配置 `--check` 返回 ok=true，读取原扫码凭证，未联网轮询或发送。
- Go：`go test -race ./... && go vet ./... && go build -o bin/super-leader-daemon .` 通过；格式化模块拆分期间曾短暂出现重复定义编译错误，移除旧定义后复跑通过。
- 最终重新执行 `node test-integration.mjs` 与 `--live --session 01a12176-6082-7150-a791-52a5f3c78c53` 均通过，真实读取 4389 字节并完成重复请求去重。
- 集成复测曾遇 PostgreSQL 初始化临时服务退出导致 `Connection terminated unexpectedly`；将就绪探针改为 TCP `pg_isready -h 127.0.0.1`，两条联调命令复跑通过。
- 已重新构建 Docker Controller/Web，更新本次启动的 native Daemon；`node local.mjs --check` 显示 macair 在线、18 条会话记录，先前正式实例的 1 条只读命令在更新后保留。
- `git diff --check` 通过；运行配置、二进制、依赖及构建产物均已验证被 Git 忽略。
- 保留交付服务：super-leader Controller、PostgreSQL 容器和前台原生 Daemon。没有注册系统服务；旧 8787 容器不变。临时测试容器及本轮失败测试目录已清理。

## 模型 Leader 增量复核（2026-10-10 20:05 CST）

- 新增统一 CommandService、多轮模型工具循环、明确确认的待执行计划、聊天记忆/历史/处理权/回执持久化；保留旧规则模式且不自动选择模型服务商。
- Controller `pnpm test && pnpm run typecheck && pnpm run build`：最终 74 项测试、类型检查、构建通过。覆盖 HTTP allowlist 先于模型调用、去重、计划确认/取消/过期、进程中断不自动重放、聊天隔离、错误脱敏、工具预算、Unicode 历史上限、传输重试及卡住流的超时。
- 首轮编排测试因测试类缺失闭合括号失败，修正后通过。状态测试初版 mock 未注入，误连本机不存在的测试库而失败；改成显式 mock 后通过，未创建或修改本机数据库。模型传输的占位测试已替换为 17 项实际行为断言，不将占位通过作为验证。
- 真实 PostgreSQL 初轮失败：原 CAS 的 INSERT SELECT WHERE revision=0 让已有状态无法更新，HTTP 返回 409。已改为原子 INSERT ON CONFLICT DO NOTHING / 条件 UPDATE 两分支。增加真实 PostgreSQL 双客户端并发验证：创建与更新分别恰有一个成功，缺失记录不能以非零版本创建。
- `node test-integration.mjs`：最终通过。真实 PostgreSQL + 本地模拟模型 HTTP + 模拟 Daemon 验证计划先不发送、Controller 重启后计划仍在、确认只发送一次、重复确认不重发、聊天记忆跨重启保留；原鉴权/命令去重/断线 uncertain 回归也通过。没有调用真实模型服务商。
- `node test-integration.mjs --live --session 01a12176-6082-7150-a791-52a5f3c78c53`：通过。真实原有会话读取 4389 字节并去重；live 模式强制 rules，未向模型传送会话数据、未发送 prompt。
- Gateway `pnpm test && pnpm run build`：14 项通过；Web `pnpm test && pnpm run typecheck && pnpm run build`：6 项通过；Go `go test -race ./... && go vet ./...`：通过。本增量未重复运行旧 Python 614 项测试，前一轮结果保留在上文。
- `node local.mjs --up`：Docker 构建与更新成功。`--check`：leaderMode=rules，macair 在线，18 条记录、4 条 send 能力记录、原有 1 条命令仍在。能力快照不代表实际发送已验收。
- `node --check local.mjs`、`node --check test-integration.mjs`、`git diff --check` 通过。临时数据库/模型桩/测试 Controller/只读测试 Daemon 已由脚本清理；保留交付 Controller/PostgreSQL/原生 Daemon，旧 8787 服务未变。
- 本次未注册系统自启、未创建备份、未提交或推送代码、未启用微信轮询。模型服务配置未提供，允许名单仍为空。
- 独立只读审查覆盖工具权限、确认入口、命令去重和聊天隔离，未报告新的高风险问题。此结论不等于零风险：发送前的状态查询与网络发送并非跨系统原子事务，记忆内容仍需防范模型受不可信输出影响；不宣称多活或 exactly-once 保障。

## 节点技能增量复核（2026-10-10 20:30 CST）

- Go Daemon 新增只读技能目录扫描、注册/心跳发布及派发前版本验证。Controller 新增认证目录 API、list_skills 模型工具、计划技能选择、命令技能引用持久化与幂等比较。技能只通过已有会话使用，不直接启动脚本。
- `pnpm test && pnpm run typecheck && pnpm run build`：Controller 79 项、类型检查和构建通过。新增目录 schema、错误节点/版本、确认前无发送、确认时失效、模型伪造技能、命令深拷贝及重复请求换技能拒绝测试。
- `go test -race ./... && go vet ./... && go build -o bin/super-leader-daemon .`：通过。新增临时目录的 YAML 多行、根软链/子软链越界/循环、UTF-8 与长度、包边界、文件版本变化、实际 Daemon WS hello/heartbeat 发布、模拟适配器派发与回执复用测试。集成早期因扫描器文件尚未落盘出现 missing package 编译失败，完成实现后复测通过。
- 首轮本机扫描返回 89 条部分记录并退出 1：错误地深入技能包参考文档触发深度限制，另有顶层安装别名目标未显式配置。改为 SKILL.md 包边界，并由本机启动器将安装目录顶层软链作为显式根；独立 probe 指定相同三个根复测退出 0，发现 82 个独立技能包。没有修改用户的技能文件。
- `node test-integration.mjs`：真实 PostgreSQL 与模拟模型/Daemon，通过技能版本随计划跨重启保留、确认后 wire 传递、命令技能引用持久化、再次重启保留、同 requestId 换技能返回 409。该验证不是实际技能执行证明。
- `node test-integration.mjs --live --session 01a12176-6082-7150-a791-52a5f3c78c53`：通过；真实会话读取 4389 字节，未发 prompt。
- Docker Controller/Web 已重新构建部署。优雅停止前轮本任务启动的 Daemon 会话后，以新二进制启动；`node local.mjs --check`：rules、macair connected=true、18 条会话记录、4 条 send 能力、82 个技能、原 1 条命令保留。未改变其他服务。
- 本轮没有重新运行不变的 Gateway/Web/Python 测试，其前次结果仅作为历史证据；没有真实模型调用或微信收发。临时测试进程/容器已清理，保留交付服务。工作流子代理已停止并由主代理完成集成，无仍在写入的子任务。
- 扫描根与包边界见 SKILLS.md。版本摘要不覆盖技能所有依赖，扫描与原会话读取并非事务；真实技能完成需用户指定会话后验收。

## Turn 终态追踪增量复核（2026-10-10 20:53 CST）

- 新增精确 turnId 持久化、只读 inspect_turn、数据库落库后 result_ack、Daemon 内存未确认回执重传。Controller 重启/节点重连仅恢复查询，不重发 send。终态记录整行不可被迟到结果覆盖；已绑定 turn 的 accepted 不因派发 TTL 过期。
- Controller `pnpm test && pnpm run typecheck && pnpm run build`：81 项、类型检查及构建通过。新增 Hub 数据库失败不 ack、错误节点/turn 拒绝、终态不被旧 accepted 覆盖、单节点查询上限和轮转测试。
- Go `go test -race ./... && go vet ./... && go build -o bin/super-leader-daemon .`：通过。覆盖精确目标非最后一轮、缺失/错误 thread、未知状态不猜测、failed/interrupted 脱敏、Unicode 输出上限、内存回执 ACK 匹配/容量上限及真实本地 WS 断线重连不重复 send。
- 合并过程中，首次 Go 构建因接口尚未落盘失败；适配器初稿又因字符串换行转义错误失败。主代理修复并收紧状态枚举和错误脱敏后重新跑上述完整验证通过。Controller 初次合并也出现类型接口尚未落盘的编译错误；最终类型检查和构建通过。
- `node test-integration.mjs`：通过。真实 PostgreSQL 双客户端竞争绑定 turnId 恰有一胜；派发 TTL 不终止已知 turn；恢复清除旧错误；迟到 accepted/failed 不修改终态；Controller 重启后 inspect 返回精确终态，发送计数不增加。保留既有模型桩/技能/幂等/鉴权回归。
- `LIVE_CODEX_SESSION=01a12176-6082-7150-a791-52a5f3c78c53 go test ./pkg/codex -run TestInspectLiveTurnReadonly -v`：通过，真实原会话 turn 返回 completed，输出 2776 字节；未发 prompt。
- `node test-integration.mjs --live --session 01a12176-6082-7150-a791-52a5f3c78c53`：通过，真实读取 4389 字节并去重；临时实例强制 rules，没有真实模型或微信消息。
- Web 6 项测试、typecheck/build 通过；新增 turnId 展示和派发截止标签断言。Gateway 14 项及 build 通过。本轮未重新运行旧 Python 测试，也未进行浏览器截图验收。
- `node local.mjs --up` 更新 Docker 成功，原本任务 Daemon 62928 正常 Ctrl+C 退出，以新二进制在工具会话 48606 启动。`--check`：rules，macair 在线，18 会话、4 send 能力、82 技能、原 1 条命令保留。其他服务未改变，没有创建备份或系统自启。
- 未确认结果队列只在内存；初次 turnId 落库前若 Daemon 崩溃仍为 uncertain，不能自动重试。协议和边界见 TURNS.md。实际用户指定会话的发送与微信端到端仍待验收，不能宣称生产就绪。
- 本轮并行子任务未及时交付完整实现/测试，已停止，由主代理接手存储、集成测试和适配器修复并独立验证。独立审查未完成，不将其记作审查通过；无仍在写入的后台子任务。20:56 再次执行 Controller 全套验证仍为 81 项通过，增加查询超时后继续轮转断言。

## 当前剩余门槛

- 用户指定测试会话后的原会话定向发送验证。
- 微信自然语言端到端验证（允许名单为空，未启动新 Gateway 轮询）。
- 模型 Leader 工具循环和聊天记忆已实现并通过模拟联调，但真实模型尚未配置/验证；运行中的入口仍为规则模式。技能发现与版本绑定委托已实现，真实技能执行未验收。Claude/Grok 适配器和持续自治仍未实现；已知 turnId 的终态追踪完成并通过只读真实验证，但初始受理落库前崩溃恢复仍有上述限制。
- 仍需生产加固：跨机 TLS 部署、真实网络故障/重连压力测试、硬件断电及数据库不可用恢复演练。Daemon 重启跨进程去重已实现并通过下述子进程测试，但不能将有限测试视为生产可靠性认证。

这份记录不将未执行测试记作通过，也不将输入受理记作 Agent 工作完成。

## Daemon 持久化增量复核（2026-10-10 21:19 CST）

- 生产入口使用 bbolt 日志：适配器调用前持久化 claim，未完成 claim 重启后仅返回 uncertain；回执保存后重传，匹配 ACK 后保留防重记录。内存构造器仅用于测试，不是启动失败的回退路径。
- `go test -race ./... && go vet ./... && go build -o bin/super-leader-daemon .` 最终通过，包含 journal 专项：accepted 重开恢复、未完成 claim 不重建、ACK 匹配与正文清除、payload 冲突、独占锁、scope、权限/软链拒绝、坏文件/坏记录/索引异常、已有零字节及缺失 schema/scope 拒绝重建。
- client 测试使用真实子进程 `os.Exit(17)` 模拟 claim 后/accepted 落盘后退出；重开后适配器发送计数为 0。另覆盖 Begin 写失败不执行、Finish 失败不重复发送及恢复后重传、ACK 后重开、防重和 UTF-8 上限。未模拟物理掉电。
- 初次构建因 Config.StateDir 尚未集成失败，接手实现后通过；首轮测试把 0755 临时目录当状态目录，被正确拒绝，改用独立 0700 子目录后通过，未放宽安全检查。存储子代理测试落盘后由主代理复核，修正测试中未检查的清理错误并补 schema 测试；子代理已停止。
- `node test-integration.mjs` 最终通过：真实 PostgreSQL、模型桩、技能、并发去重、turn 绑定及重启只读追踪回归。没有调用真实模型。
- `node test-integration.mjs --live --session 01a12176-6082-7150-a791-52a5f3c78c53` 最终通过：真实 Mac Air 既有会话读取 4389 字节并去重，无 prompt 发送。测试使用独立临时日志目录，结束后由 finally 清理。
- `GOOS=linux GOARCH=amd64 go build -o bin/super-leader-daemon-linux-amd64 .` 通过交叉编译；未在远端运行。
- 仅优雅更新本任务原生 Daemon，旧会话 48606 正常退出；新版本在 38381 启动后执行正式 Controller 只读命令 `cmd_517507ea-ca05-4fbf-b23d-27da8bd47880`，completed、4389 字节；日志文件 131072 字节、0600。再次正常重启至会话 10629 成功，`node local.mjs --check` 返回 rules、macair 在线、18 会话、4 send 能力、82 技能、2 条命令保留。
- `git diff --check`、两个 mjs 的 `node --check` 通过。未重建不变的 Controller 容器；本轮未重跑 Controller/Web/Gateway/Python 单元测试，历史结果不算本轮新证据。
- 最终 Docker 列表仅含本项目 Controller/PostgreSQL 和既有 vibe-quant；无临时测试容器残留，保留正式原生 Daemon。未改系统配置、未创建备份、未发微信或真实会话 prompt、未提交推送。运行和恢复边界见 TURNS.md。

## 微信 Unicode 展示增量复核（2026-10-10）

- 单消息截断与多段切分原先按 UTF-16 索引直接截取，会切开 emoji 代理对。两条路径现在复用 Unicode 安全边界；非法、非有限、非整数长度明确拒绝。单段允许零预算；分段无法容纳单个 Unicode 字符时拒绝，避免死循环或超限。
- `cd gateway && pnpm test && pnpm run build`：17 项测试及 TypeScript 构建通过。新增逐预算截断、多段原文重组、UTF-8 往返无乱码、非法长度覆盖；既有多段失败续传、消息去重、允许名单与 checkpoint 回归通过。
- `git diff --check` 通过。未启动 Gateway，测试只用模拟 fetch；没有真实微信或模型调用。此修复保证不切开代理对，不保证组合字素（如 ZWJ emoji）一定处于同一段；真实微信显示仍需端到端验收。

## 多节点隔离增量复核（2026-10-10）

- 新增 `controller/tests/multi-node.test.ts`，同时连接两个模拟节点，使用相同 sessionId 和标题，通过真实 CommandService + NodeHub + MemoryStore 路径验证精确节点派发、跨节点伪造回执拒绝、单节点断连不影响另一节点命令和发现列表、重复在线身份拒绝、认证身份与 hello 不符拒绝。
- `cd controller && pnpm test && pnpm run typecheck && pnpm run build`：83 项、类型检查和构建通过；`git diff --check` 通过。测试未使用真实网络或真实远程机器，不将其描述为跨机端到端验收。
- `node local.mjs --check`：rules、macair 在线、18 会话、4 send 能力、82 技能、2 条命令，未新增真实命令。无生产代码变更，不重启服务。
- 独立只读审查子代理未在本轮交付可复现结论，已中断；不计作审查通过。尚需审计连接关闭与异步存储操作交错时的代数隔离，并进行真实跨机 TLS / 重连演练。

## 重连迟到回执增量复核（2026-10-10）

- 用可控 Promise 阻塞旧连接的 getCommand，替换连接并写入同一 turn 的新输出，再释放旧查询。修复前断言失败：期望 current output，实际 stale output。初版不同 turn/status 场景已被既有存储状态机挡住，因此没有把初版测试通过误判为无竞态。
- Hub 在命令查询返回后重新验证当前连接对象与 OPEN 状态；旧连接不再继续提交回执。可持久化回执由新连接重传，不重发 prompt。
- Controller `pnpm test && pnpm run typecheck && pnpm run build`：84 项、类型检查与构建通过。构建完成后重新执行 `node test-integration.mjs` 通过真实 PostgreSQL、模型桩、技能、turn 跟踪及重启回归；没有真实模型/微信调用。
- `node local.mjs --up` 已更新本地 Controller，Daemon 继续使用原生进程自动重连；未修改系统配置、未创建备份、未发送真实任务。`git diff --check` 通过。
- 范围限制：已修复查询等待期间连接替换的确定性复现；数据库写入本身已经发出后的交错、会话快照删除/更新交错仍需进一步审计，不宣称已实现数据库级连接 fencing 或完整生产故障验收。

## 联调目标选择入口（2026-10-10）

- 新增本地启动器 `--sessions`，复用认证后的状态查询，只投影节点/会话 ID、标题、provider、status、capabilities、observedAt、canSendNow，不打印命令输出、工作目录或凭证。此为运维入口，不改变微信自然语言交互。
- `node --check local.mjs`、`node local.mjs --help`、`node local.mjs --sessions` 通过；实际返回 18 会话、4 个在线空闲且支持 send 的候选。
- 使用 Node assert + spawnSync 实际执行 CLI，断言输出字段白名单、canSendNow 条件以及 `--sessions --daemon` 冲突模式退出 1，全部通过。`--check` 命令数仍为 2，未触发派发；`git diff --check` 通过。
- 候选能力是发现快照，不证明实际发送成功；仍待用户指定目标后执行原会话发送验收。没有启动微信轮询或新增后台进程。

## 微信 API 地址凭证边界（2026-10-10）

- 新回归在修复前失败（Missing expected exception）：iLink 构造器接受明文 HTTP 地址。现在账号文件与显式配置采用统一 HTTPS 校验，拒绝 userinfo、query、fragment、控制字符和反斜杠；错误不回显原地址，阻断前 fetch 调用次数为 0。
- `cd gateway && pnpm test && pnpm run build`：19 项、构建通过。覆盖账号/配置两条输入路径、默认及区域 HTTPS 地址、路径前缀、显式覆盖及 fetch 的 redirect=error 参数。没有发起真实网络请求，不将参数断言称为真实重定向服务器验收。
- 未修改真实微信账号文件、未启动 Gateway、未发送微信。自定义 HTTPS 域名仍由操作者信任；此补丁不宣称域名白名单或全面 SSRF 防护。

## 回执等待器生命周期（2026-10-10）

- 新增四项确定性计时器测试，修复前取消、关闭、同 commandId 替换三项失败。原 cancel 清除了定时器却不 resolve Promise；closeAll 只清 Map 而保留 timer；旧等待器取消可误删替换后的回调。
- 现在结果、超时、取消、替换、关闭共用 settle；只删除自身回调，取消返回 null，不伪造 Agent 终态、不发送撤销或重试。关闭完成后等待器不再持有 timer。
- `cd controller && pnpm test && pnpm run typecheck && pnpm run build`：88 项、类型检查和构建通过。`node test-integration.mjs` 真实 PostgreSQL/模型桩/turn 恢复回归通过；`git diff --check` 通过。
- 已通过 `node local.mjs --up` 更新 Controller；没有启动新 Daemon、真实模型或微信收发。测试使用假时钟验证等待器，不宣称数据库永久挂起时也能有界退出。

## Mac Mini 真实只读兼容性探针（2026-10-10）

- `ssh -o BatchMode=yes -o ConnectTimeout=12 macmini` 直连成功；只读检查返回 hostname=Wentaos-Mac-mini.local、架构 arm64、既有 Codex Unix socket 存在。不需要 CF 备用通道。
- 通过本次 mktemp 创建的私有目录建立临时 SSH Unix socket 转发；本机已构建 Daemon 以 `--probe --node-id macmini --sock <临时socket>` 执行，退出 0。返回 1 条 codex-app 会话，状态 notLoaded、0 条 send 能力；未读取正文、未发送 prompt、未 resume。
- 此结果证明当前适配器可与 Mac Mini 既有控制 socket 完成只读发现；不证明所有 Mac Mini CLI 会话已覆盖，也不证明可控制执行。需要用户打开允许测试的原会话后重新观察能力，不能自动恢复历史会话冒充附着。
- SSH 工具会话 97167 检查结束后 Ctrl+C 关闭（SSH 退出 255）；仅删除本次临时 socket 与空目录，没有安装远端二进制、创建远端日志、分发 token、改系统配置或注册节点。正式 `--check` 仍只有 macair、18 会话、4 send 能力、82 技能、2 条命令。
- 跨机正式部署仍需确定 Controller 的 HTTPS/WSS 入口及独立节点凭证。临时 socket 转发只是诊断手段，不代替宿主机原生 Daemon 架构；未用该转发派发任何操作。

## 公司机器只读接入前置检查（2026-10-10）

- 对 devbox/devsg/devos 运行 `ssh -o BatchMode=yes -o ConnectTimeout=12 <alias>`，远端仅计划查询 hostname、架构、Codex 命令及控制 socket 是否存在，未读取会话或凭证。
- devbox/devsg 均退出 255：`Could not resolve hostname`。独立 `ssh -G` 核对 hostname 仍分别为原始别名，当前主机没有解析出实际目标；不能据此判定远端机器离线。
- devos 首次和一次重试均退出 255：`Connection timed out during banner exchange`。`ssh -G devos` 确认依赖 ProxyJump macpro；单独检查 macpro 也退出 255、连接超时。因此目前只能确认入口链路不可达，无法判断 devos 的 Codex/socket 状态。
- 没有安装程序、改 SSH 配置、分发 token、触发会话执行或传送公司会话内容；所有 SSH 检查已终止，没有遗留转发。Mac Air `--check` 仍在线，18 会话、4 send 能力、82 技能、2 条命令。
- 继续正式跨机验收需要从当前 Mac Air 可用的公司机器连接入口，或恢复已配置跳板。未猜测其他地址、账号或私有网络路由，也不把 Linux 交叉编译成功当成远端运行成功。

## Web 真实浏览器基础验收（2026-10-10）

- 使用 ego-browser TaskSpace 28 加载本地 `http://127.0.0.1:8790/`。首次 snapshot 空且 fill 失败，page.info/evaluate 独立确认 viewport=0×0；只对该测试 Page 设置 1280×900 后认证表单可交互，没有修改应用或浏览器全局配置。
- 无凭证时展示认证引导。错误测试 token 返回页面“控制平面认证被拒绝 / 权限拒绝 (403)”；初始等待条件只匹配 401/认证失败而超时，重新检查真实 snapshot 后确认是 403，不把等待超时当作认证放行。
- 读取本项目私有配置并直接填入密码输入框，未打印 token。正常登录后 DOM 确认 macair 和已发现会话标题出现；localStorage/sessionStorage 为空、cookie 为空、URL 无查询参数、密码框消失。
- 切为 390×844 视口，documentElement.scrollWidth=390；刷新后重新出现密码框，原会话标题不再显示，localStorage/sessionStorage 仍为空。未操作派发，不产生新命令。
- 浏览器观察发现错误凭证仍每 5 秒重试，待修；Controller ONLINE 标签来自公开 health，并非登录成功证明。这里只验收基础 DOM/交互，不宣称截图视觉审查或所有响应式布局完成。
- 已执行 task.finish({keep:[]}) 关闭测试空间，未清除用户其他站点数据。工具提示 Ego Lite 更新可用，已告知用户但未升级。未新建后台进程或截图文件。

## Web 鉴权失败轮询修复（2026-10-10）

- 401/403 后停止自动轮询，清除之前取得的会话/命令数据与同步时间；普通 502 不停止恢复尝试。换凭证后重新启动轮询，显式手动刷新仍可发起一次请求，成功后恢复自动轮询。清空 token 时也重置公开健康状态。
- 新 hook 回归测试修复前两项失败（鉴权拒绝后旧 data 非 null）；修复后覆盖 401/403 无后续定时请求、新 token 恢复、502 自动恢复。`cd web && pnpm test && pnpm run typecheck && pnpm run build`：9 项、类型检查及构建通过。
- `node local.mjs --up` 已更新 Docker Web，入口引用新构建 index-CsvLFRlu.js；`--check` 仍为 macair 在线、18 会话、4 send 能力、82 技能、2 条命令。`git diff --check` 通过，无真实发送或微信轮询。
- 本增量未重新打开浏览器做请求计数；真实浏览器发现问题与单元测试修复证据分别记录，不混称为完整端到端复测。

## Web 实际 Leader 模式展示（2026-10-10）

- Web API 原先丢弃 Controller 的 leaderMode；现在保留 rules/model，缺失或未知值明确归为 unknown。认证后展示规则模式能力限制、模型模式不等于服务健康/任务完成、未知模式不推断开启模型；网络错误时标为上次成功快照。
- 新增四种响应值的 UI 回归，覆盖未认证不显示模式、规则/模型/缺失/异常值文案，只访问只读状态与健康接口。`cd web && pnpm test && pnpm run typecheck && pnpm run build`：13 项、类型检查与构建通过。
- `node local.mjs --up` 部署完成，HTTP 入口引用 index-Be0basjc.js；`--check` 返回 leaderMode=rules、macair 在线、18 会话、4 send 能力、82 技能、2 条命令。`git diff --check` 通过；没有启用模型、微信或发送任务。本轮未做新增面板的真实浏览器视觉复测。

## 其他 CLI 接入前置检查（2026-10-10）

- 本机 `command -v claude` 定位到已安装 CLI，`claude --version` 返回 2.1.220。只读取 `claude --help` 与 `claude agents --help`，没有启动会话或调用模型。
- `claude agents --json` 的本机帮助说明列出 active interactive/background sessions，实际执行退出 0，返回空数组。输出只保留数量/字段名/状态，不打印会话正文。当前没有可验证的已有 Claude 会话样本，不能猜测非空 JSON schema 或声称完成附着。
- 帮助中的 print/stream-json 是新进程输入输出接口，resume/continue 是恢复路径，不能据此当作既有交互进程发送能力。agents JSON 可作为未来发现入口；真正 send 仍需原会话控制协议或用户明确的终端承载方式与目标验收。
- `command -v grok` 无匹配，仅证明当前 PATH 没有此名称，不断言机器完全未安装其他发行版或包装器。需用户说明具体 CLI 名称/路径与测试会话。
- 未创建任何 Claude/Grok 新会话、隔离 worker、worktree 或后台进程，未改 CLI 配置。Claude/Grok 适配仍未完成；下一步需要可测试的实际会话及可靠控制接口证据。

## 真实模型、原会话控制与模拟微信（2026-10-11）

- 读取当前 Codex provider 配置，使用其 API 地址和环境凭证，显式选择 `gpt-6.1-sol`。真实 Responses 请求返回 HTTP 200；工具调用续传返回 `SL_TOOL_ROUNDTRIP_OK`。仅保留 Responses transport，包含 reasoning output 与 function_call_output 续传，不保留 Chat Completions 兼容分支。未打印或写入 API 密钥。
- 容器首次请求出现 `EAI_AGAIN`，只读检查发现 `NO EXTERNAL NAMESERVERS DEFINED`。代理探测过程中存在一次 `proxy tcp timeout`，不能将该次探测算作成功。仅为本项目 Controller 配置 `NODE_USE_ENV_PROXY` 和 `CONTROLLER_HTTPS_PROXY`，随后真实模型及模拟微信全链路通过；没有改 DNS、代理或其他系统配置。
- 显式新建专用会话 `01a1274e-7954-7862-a091-d5251aef0a8b`（Super Leader macair 联调会话），使用既有 Unix socket，不启动新 app-server。此前关闭连接后卸载的测试会话被 Controller HTTP 400 拒绝发送，未隐式 resume。没有向用户已有工作会话发送任务。
- 直接发送验收：`cmd_6dfdba75-c6bc-4fa9-8da3-9935a904e0f2` 对应 turn `01a1274f-6ca4-7433-bb45-9de8d5257572`，精确 completed，输出 `SL_CONTROLLER_OK`。
- `node test-live-session.mjs --session 01a1274e-7954-7862-a091-d5251aef0a8b` 通过：`cmd_dd94c5a3-774d-46cf-af8e-66e94a7bc1cb` / turn `01a12753-6a46-7c02-9730-3b79e4ecb534`；实际输出随机 marker，执行中及完成后 request 重放均指向同一 turn。
- `node test-wechat-model.mjs --session 01a1274e-7954-7862-a091-d5251aef0a8b` 在目录迁移后再次 SUCCESS：`cmd_9c82b6ef-3e6c-4b4a-b75b-74de67800788` / turn `01a12759-a6a6-7ab2-8007-ff9528ab8dda`，completed 输出 `SYNTH_MARKER_1791661539873_8o3186`。覆盖自然语言计划、确认前未派发、确认后实际完成、重复 inbound 零回复、重复确认无新增 send、结果查询回复含实际输出。模拟仅替换微信网络，Controller、模型、Daemon 和会话均为真实组件。未读取真实微信 token，未启动真实 Gateway；临时假账号/游标目录自动清理。
- 组件验证：`pnpm --dir controller test` 96 项；`pnpm --dir gateway test` 19 项；`pnpm --dir web test` 13 项；`node --test local.test.mjs test-live-session.test.mjs` 8 项，全部通过。Controller 类型检查与构建、Gateway/Web 构建、`cd daemon && go test -race ./... && go vet ./... && go build -o bin/super-leader-daemon .` 均通过。
- `node test-integration.mjs` 真实 PostgreSQL 集成全部 PASS，覆盖 CAS、turn 绑定不可变、技能、模型计划重启恢复、记忆和去重。CLI 测试原有一项依赖在线节点，在迁移重连窗口失败；已改为自身 HTTP 桩验证无 POST，8 项重跑通过。本轮未重复真实浏览器视觉验收。
- 用户要求不保留旧实现：目录已平铺为 controller/gateway/daemon/web，无双版本目录；旧 Python 源码、测试与入口已删除。既有 PostgreSQL 物理卷、Daemon journal、旧 SQLite 数据及凭证保留；物理卷原名称只用于保留数据，不是兼容层。历史文档路径按当前布局更新。未提交旧源码没有 Git 恢复保证，未创建备份。
- 仍未证明：真实微信端到端、Claude/Grok 和所有独立 CLI 的控制、正式跨机部署、持续自治及依赖调度。不能将本次专用测试链路通过描述为完整生产保障。
- 收尾：不带 `--simulation-chat` 重新构建部署成功；`node local.mjs --check` 显示 model、macair connected、8 条历史命令。独立 HTTP 断言验证允许名单为空、模拟 chat 请求返回 403、上述验收命令重启后仍为 completed。已 Ctrl+C 正常关闭本轮 fixture 连接（退出 0），未停止 Codex；人工验收前需重新在 App 打开测试会话并确认 send 能力。保留 Controller/PostgreSQL 与原生 Daemon 作为运行服务，未启用真实 Gateway。`git diff --check` 通过。

## 微信分段内容保真与 checkpoint 回滚（2026-10-11）

- 故障注入证明：`recordProcessedMessageKey` 落盘失败时原实现只回滚 processed 集合，丢失已发送片段数（断言实际 0、预期 2）。现在同时恢复该进度；测试覆盖内存、磁盘重载、恢复写入后成功完成并清除进度。它不声称解决远端已发送但本地尚未落盘的网络不确定窗口。
- 内容测试证明：原分段逻辑在小预算下把 `if ready:` 变成 `ifready:`，并删除代码缩进和空行。现在仅切片、不 trim 每个片段，换行计入片段预算；所有测试预算下重组与输入严格相等，且不割裂 UTF-16 surrogate pair。仅纯空白整体输入仍返回空数组。
- 原网络失败恢复测试因预期片段不含换行而失效，已更新为含换行的真实内容及完整重组断言，不放宽重试/游标断言。并增加测试 finally 清理，删除本轮一次失败遗留的假账号临时目录；未触碰真实账号。
- 验证：新增测试均先观察到失败；修复后 `pnpm --dir gateway test` 21/21 通过，`pnpm --dir gateway run build` 与 `git diff --check` 通过。未启动真实微信、未新增后台进程、未改部署或系统配置。
- 按初始化技能核对既有 scaffold symlink 正确；项目已初始化，遵循技能的不覆盖约束，没有重建目录或覆盖 README。编排技能用于将独立只读 Markdown 审查与状态修复拆开。

## 双节点控制平面隔离验收（2026-10-11）

- 新增集成辅助模块 `test-node-isolation.mjs`，由既有 PostgreSQL 集成脚本调用；两个节点使用独立随机 token、相同 sessionId 和标题，测试不访问真实 Codex/微信。
- 验证 token A 冒报 node B 时 WebSocket 4003 关闭；正常注册后定向命令只出现在对应节点的 socket；B 持有 A 的精确 commandId/turnId 仍无法提交伪造 completed，数据库记录保持不变且无成功确认。
- A 断线时仅 A 的活跃命令转 uncertain，B 保持 accepted 并可继续 read；离线 A 新指令返回 503。A 重连收到精确 inspect_turn，原命令恢复 completed，未收到新 command，B 原命令仍保持 accepted。
- 首次测试错误地期待 HTTP 立即返回 accepted，实际按异步协议返回 pending；修改测试为等待精确 commandId 的 accepted/completed，而非改变服务语义。再次 `node test-integration.mjs` 所有检查 PASS（包括既有 CAS、持久化、技能、模型计划、记忆及重放检查）；`pnpm --dir controller run build` 通过。
- 两次测试的临时 PostgreSQL 容器及 Controller/模拟 socket 均由 finally 清理。`docker ps` 仅保留既有 super-leader 两容器和无关的 vibe-quant 容器；未改远端机器、系统配置、实际微信或运行中会话。本证据不证明物理跨机 TLS 部署成功。

## 大技能目录定向查询（2026-10-11）

- 现有每页 20 项与每轮最多 6 次模型调用限制，使 82 项目录的尾部技能查询可能耗尽后续会话查询/计划预算。增加 `list_skills.query`，对名称和描述做字面子串匹配，支持节点范围并在过滤后分页；保持工具输出不可信、路径不暴露及版本绑定不变。没有新增兼容入口或放宽执行授权。
- 新测试把目标放在第 81 项，一次查询找到目标，绑定 digest 生成计划，确认前无 send、确认后精确技能引用派发；另覆盖中文描述、大小写、查询首尾空格、匹配集分页、节点隔离、无匹配、正则元字符仅作字面量、空/超长查询拒绝。
- 新增 6 个用例，其中 4 个功能用例在改实现前失败（query 不在工具 schema 中）；实现后 Controller 102/102 通过。`pnpm --dir controller run typecheck`、`pnpm --dir controller run build`、`node test-integration.mjs`（含双节点与 PostgreSQL）及 `git diff --check` 均通过。
- 本轮没有重新部署正在运行的 Controller，也未向真实会话发送技能任务。测试证明查询/计划/授权链路，不能代替真实模型选择技能或原会话执行技能的验收。

## 真实技能查询与模型记忆验收（2026-10-11）

- 使用现有模型/代理环境运行 `node local.mjs --up --simulation-chat synthetic-skill-search`，将技能搜索更新部署到本机 Docker Controller；构建成功，Mac Air Daemon 自动重连，仍发现 82 项技能。不更改私有配置允许名单，不启动真实 Gateway。
- 经 Controller `/v1/messages` 注入只读自然语言消息 `skill-search-06f953d8-2e6d-4ca8-98f2-ca3ad2240df3`，要求查询实际目录最后一项 `work`。真实 gpt-6.1-sol 回复含准确 ID `19264bc2913a2482d5ec389674a53d0d66db0b5064b73e4af1a19fe548cdcc3e` 与 digest `ff3541b81fb1fb2e543243824ec2b28234eeab1afab8388c446e1c1c11e6c663`；与独立 `/v1/status` 目录严格比对一致，未返回 commandId，前后 commandId 集合相同。回复自述使用 query，但没有保存模型内部调用 trace；因此只将结果准确性与无派发视为实测证据。
- 同一合成聊天请求记住 `acceptance-preference` 的随机 `SL_MEMORY_<uuid>` 测试值；直接 `docker exec super-leader-postgres-1 psql -U leader -d leader -Atc ...` 查询该 chat 的 `leader_states.data.memories` 验证准确写入，随后模型回忆返回准确值，再请求忘记并查库验证键消失。三步 PASS，未输出任何真实凭证。历史聊天记录仍有模拟测试内容，这是验收记录，不声称 forget 会擦除历史消息。
- 测试后不带 simulation 参数再次 `node local.mjs --up`，启动成功。独立断言：model 模式、macair connected、命令数仍为 8、私有允许名单长度 0、合成 chat 再请求返回 HTTP 403。未启动真实微信、未创建测试会话、未向已有会话发送任务，保留既有数据库及 journal。
- 本轮依据 env-must-read 仅从既有私有配置/进程环境读取凭证，不回显或落盘密钥、不改系统配置。原会话实际技能执行、真实微信与物理跨机部署仍未验收。

## 原会话真实使用 Skill（2026-10-11）

- 依据用户“自行新建会话测试”的授权，`node test-live-skill.mjs --run` 连接既有 Codex Unix socket，新建 `01a1276a-b4b4-7f01-b91f-4a1106687545`，标题“Super Leader Skill 只读验收”，model=gpt-6.1-sol、approvalPolicy=never、sandbox=read-only。未启动新 app-server 或隔离 worker，也未 resume/使用现有工作会话。
- 官方协议来源已搜索并读取 https://learn.chatgpt.com/docs/app-server ，使用 initialize/initialized、thread/start、thread/name/set、thread/read；不把官方示例中另启服务作为本项目方案。
- 从在线目录选择 ai-scaffold-init，绑定 digest `c6e840cb929d0a06c378ef62bbf8265dffa5353916c7c25103199ddd49290838` 后经 Controller/Daemon 派发；命令 `cmd_1ccfc99a-690f-4812-89a1-e958cfe7f01c` 对应精确 turn `01a1276a-cacc-71b2-8e57-92cc63e3a757`，最终 completed，包含随机 marker `SL_SKILL_897f71aa-bec9-4581-a54a-5bc6960345ed` 与准确 digest。
- 初次脚本 PASS 后，独立只读 thread/read 再核查该 turn：3 条 commandExecution 均 completed、exitCode=0；实际执行 `cat .../ai-scaffold-init/SKILL.md` 与 `shasum -a 256`、`ls/readlink` 四个链接、`/bin/ls -ldL` 验证目标存在。工具输出含完整技能正文与正确摘要；四个链接符合要求，无 fileChange 项。仅验收 Verify 中指定只读项，不能宣称重做完整初始化或所有技能均已运行。
- 可复用脚本后续加严目标/skill refs 绑定、工具退出码、hash 命令和四个链接输出检查，补配置解析错误脱敏与握手超时；这些条件也由上述独立读取的真实记录满足。`node --check test-live-skill.mjs`、`--help`、`git diff --check` 通过，未为修改断言重复创建会话。
- 测试进程退出 0、socket 已关闭；保留用户可查看的测试会话和命令证据。`node local.mjs --check` 为 macair connected、21 会话、82 技能、9 命令；真实微信未启动。技能的不覆盖约束限制了测试会话行为；该会话未修改项目文件、创建备份或运行外部业务操作。
- 独立脚本审查后，进一步加入原生 agentMessage 的 marker/digest 断言、固定只读测试允许命令及 shell 语法检查、敏感路径禁止，并将日志改为输出长度而非完整回复。此为事后检测，不宣称命令字符串检查是安全沙箱；实际运行使用 read-only 策略且上述三个实测命令均已人工核对。后续加严版本只做语法/help 验证，未重复创建执行会话。审查建议的自动归档未采用：测试历史作为证据交接；不采用吞清理错误。Node events.once 本身会拒绝 error 事件，不需要额外 Promise.race。

## 香港控制平面部署（2026-10-11）

- 用户授权安装 1Password CLI 并部署香港 VPS；`op --version` 为 2.39.0，`file -L /opt/homebrew/bin/op` 确认 arm64。服务账号 token 文件/目录为 0600/0700，仅注入子进程环境。Web 管理凭证存入 `DEV-CREDENTIALS/Super Leader HK`，独立读回比对一致。最初 Node 子进程 stdin 提交后密码字段为空，验证阻止了误报；改用真实管道写入后再次核验成功，没有输出密钥。
- 香港 Ubuntu 22.04 x86_64，项目 `/opt/super-leader`。Docker 构建 Controller/Web 成功，两个项目容器 healthy；Controller 非 root、只读 rootfs、512MiB，宿主仅绑定 127.0.0.1:8790；PostgreSQL 256MiB，无公网端口。原有其他业务容器和 Nginx 站点未重启或修改。
- 用户确认域名 `leader.taoai.site`，A 记录指向香港且 proxied=false。独立 Nginx 站点 + Let's Encrypt 证书（有效期至 2027-01-09），`nginx -t` 通过、certbot.timer active。公网直连 `/health` 与 `/` 返回 200，未认证 `/v1/status` 返回 401；TLS 校验通过，没有使用 `-k`。一次 Mac Air 实测 TCP 约 66ms、HTTPS 健康请求约 243ms；不是手机运营商延迟。
- 首次容器启动因 YAML flow 数组把 tmpfs 的逗号分割为两个挂载，报 `invalid mount path: 'mode=1777'`；将整项引号包裹后启动成功。部署回归 3 项验证 tmpfs 单挂载、端口边界、Nginx WSS 头及 HTTPS 跳转。
- 本地无在途命令且 Daemon 不在运行时，停本项目旧 Controller，PostgreSQL 直接流式迁移至香港空库。commands/messages/leader_states 分别 9/11/2 条；源/目标整行 MD5 分别 `7be7e51c8c513358cab034df4c5ebffd`、`16a19049c3e039570436cc4bb7ec647c`、`625539f24859a48b08b7ae54ff0402f3`，完全一致。未生成 dump 或备份文件，原本地卷保留但不再是编排权威；香港后续新增测试记录后不能重复迁移覆盖。
- 香港实际调用用户指定 provider 的 gpt-6.1-sol，只读自然语言“查询在线节点”请求成功（messageId `df19b8c7-6856-434d-9bd4-f043ae59b4e0`），当时正确回复无在线节点且无 commandId。证明模型可用，不冒称节点控制链路完成。
- Web 香港入口真实浏览器登录成功，显示 model、9 条历史 completed 命令；localStorage/sessionStorage 为空。测试 Page 初始 viewport=0，设置该 Page 尺寸后可交互。一次等待文案错误导致超时，实际页面文案为 `CONTROLLER: ONLINE`；DOM 再核查确认成功，不把等待条件当成功证据。
- 本轮主 Agent 重跑：Controller 102 项、Gateway 21 项、Web 13 项、CLI/部署 21 项均通过；Controller/Gateway/Web 构建与类型检查通过，`node test-integration.mjs` 所有 PostgreSQL/CAS/双节点隔离/模型计划/技能/记忆/只读恢复断言 PASS。新增原生服务和 journal 迁移另记后续真实验收结果。

### Daemon journal 显式切换

- 直接启动指向香港的 Daemon 被原有 scope 保护拒绝：`journal belongs to a different node/controller/socket scope`。没有用新空目录绕过，也没有删除或伪造历史状态。
- 新增 `daemon/cmd/journal-migrate`：默认只读 dry-run，仅显式 `--apply` 更新绑定；要求原 scope 正确、0 pending、记录 finished/acknowledged、拒绝 uncertain。初始 accepted 回执需要受认证 Controller 的同 commandId/nodeId/turnId 终态摘要，不把 accepted 当作在途或完成本身。
- `go test -race ./pkg/journal ./cmd/journal-migrate` 和 `go vet ./pkg/journal ./cmd/journal-migrate` 通过；独立只读审查确认事务只修改 meta scope，records/pending 不变，禁止缺失库时创建空库。
- 实际使用 `.runtime/hk-terminal-receipts.json` 中 7 条 send 终态摘要，与香港 9 条命令独立核对（另 2 条是无 turnId 的读取类命令）。原 journal 有 8 条防重放记录：0 pending、8 completed-equivalent、7 accepted 经终态证明。记录数不强行等于 Controller 的完整审计历史。
- dry-run、apply、再从新 scope 做反向 dry-run 三次 records SHA256 都为 `7613ebfe1d2bc07623ecbd7fe8f3d0c699a97681edbd96d966793def052bb505`。最终 scope 为 `8172c9c4585c168600d9b88600dfae5387be6ccb9a7e8c9127db1beeb826ce09`，仅表示已绑定香港；反向检查没有 apply，未回退。

### 香港真实会话与模拟微信闭环

- 首次 Daemon 连接遇到系统 DNS `no such host`，系统 curl 同样失败；默认路由器、1.1.1.1、223.5.5.5 的 dig 均返回正确 IP，`curl --resolve` TLS 请求成功。仅临时前台测试进程使用 Go DNS resolver；系统默认解析恢复后去掉该参数仍成功。没有改系统 DNS、hosts、代理，正式服务不含 `GODEBUG`。Controller 重启短暂 502 后 Daemon 自动重连，没有重发任务。
- 通过既有 Codex socket 新建专用会话 `01a129a9-94b7-7101-ab0f-c9ffaa3e9744`，标题“Super Leader 香港部署验收”，cwd 为 `/Users/luwentao/Workspaces`，model=gpt-6.1-sol、approvalPolicy=never、sandbox=read-only。只测试新建目标，不使用用户工作会话，不另启 app-server。
- `node test-live-session.mjs --session 01a129a9-94b7-7101-ab0f-c9ffaa3e9744 --controller https://leader.taoai.site` 通过。command `cmd_9ed916b9-e2c4-46ea-8621-030dd9d62d8f` / turn `01a129a9-c937-7e61-8b9d-fa4554c95231` 为 completed，实际输出 `LIVE_HARNESS_MARKER_34158c69-ef50-45c4-91d5-09c47ef8093e`；执行中及终态重放均返回原 command/turn。
- `node test-wechat-model.mjs --session 01a129a9-94b7-7101-ab0f-c9ffaa3e9744 --chat synthetic-hk-deploy --url https://leader.taoai.site` 通过。command `cmd_0ecde0e4-7695-4fe1-9b73-7bf7520e41f2` / turn `01a129aa-3595-7210-b357-0135e5e03508` completed，输出 `SYNTH_MARKER_1791700369397_bxu6sx`。自然语言计划、确认前零发送、确认后完成、重复 inbound 零回复、重复确认无新派发、查询实际输出均 PASS。仅 iLink 网络为模拟，香港 Controller、模型、Daemon、会话均是真实链路。
- 随后通过独立原生 `thread/read` 核对两个精确 turn：均 completed，agentMessage 含上述随机标记，无 commandExecution/fileChange/mcp/web/dynamic 工具调用。测试连接正常关闭后目标可能 notLoaded，只保留只读能力，不自动 resume。
- 香港 synthetic 允许名单已清空，只重建本项目 Controller。独立验证 macair 自动重连，命令数保持 11、两条测试仍 completed，模拟 chat 再请求返回 403。真实微信 token 未上传香港，真实 Gateway 未启动，临时假账号及 checkpoint 目录已清理。

### 项目迁移与平台原生用户服务

- 用户要求项目移至 `~/Workspaces`：确认目标不存在后，使用原地 rename 将 `/Users/luwentao/Documents/ordinary/wechat-super-leader-bot` 移到 `/Users/luwentao/Workspaces/wechat-super-leader-bot`。移动前后 Git HEAD/porcelain 一致，私有配置、journal、终态摘要的内容哈希与权限一致；原目录不存在，没有创建副本、备份或兼容软链接。
- 新增 `daemon/pkg/service`：macOS 使用当前用户 LaunchAgent（bootstrap/bootout/print），Linux 使用 `systemctl --user`；标准 Go flag 统一 `--service install|start|stop|restart|status|uninstall`。稳定二进制位于 `~/.local/share/super-leader/bin/super-leader-daemon`，不以 Node 包装，不依赖 shell 启动文件，不保留旧服务名称或双版本适配。
- 安装/覆写前核验服务归属、当前 UID、regular file 和拒绝 symlink；稳定二进制、token 和服务定义使用原子写入。runner 仅调用绝对平台管理器路径、传最小环境。plist/unit 只有 token 文件路径，不包含 node/controller/API token。卸载仅移除服务定义，保留运行状态；不使用 sudo 或自动开启 linger。
- Mac Air 实际安装成功，`plutil -lint ~/Library/LaunchAgents/site.taoai.super-leader-daemon.plist` OK。token 文件为 0600、state-dir 为 0700，与现有节点凭证一致；服务定义引用 Workspaces 新路径，无旧 Documents 路径。安装后 PID 99554，重复 start 不变；restart 后 PID 103，`ps -p 103 -o pid=,comm=` 独立确认是稳定路径二进制。
- `~/.local/share/super-leader/bin/super-leader-daemon --service status` 退出 0；restart 后香港状态显示 macair connected、命令数仍 11，无重发。本轮三个临时前台 Daemon 均已正常结束，仅保留交付的 LaunchAgent；旧本地 Controller 已停止，本地数据库及历史数据仍保留。
- `cd daemon && go test -race -count=1 ./... && go vet ./...` 全部 8 个测试包通过。服务测试共 5 个顶层用例，涵盖两平台生成/转义、凭证保护、归属检查、管理动作和错误传播；增加精确管理器 argv 断言后 `go test -race ./pkg/service && go vet ./pkg/service` 再次通过。macOS arm64 与 Linux amd64 构建均成功；Linux 未实机安装，不能把 fake runner 单测当作真实 systemd 验收。
- `node --test local.test.mjs test-live-session.test.mjs test-wechat-model.test.mjs deploy/config.test.mjs` 最终 22/22 PASS。修复 local.mjs 被 import 时不应解析调用方 CLI 的副作用；远程 HTTPS 验收入口与禁止远程目标误执行本地 up/down 的约束均覆盖。没有为此重复发送真实任务。

### 香港 Web 与最终边界

- 同一真实浏览器 TaskSpace 登录香港入口：model、macair 在线、22 会话、11 completed、0 在途；390×844 时 scrollWidth=390，无横向溢出。localStorage/sessionStorage 均为空，刷新后重新出现登录框且隐藏数据，再登录成功。
- 截图接口两次超时，没有得到截图文件，因此只记录真实 DOM/交互验收，不声称截图视觉验收完成。测试 TaskSpace 已关闭；Ego Lite 提示有更新，未擅自升级。
- 最终轻量检查：`node local.mjs --check --controller https://leader.taoai.site` 返回 model、macair connected、22 会话、4 send 能力、83 技能、11 命令；默认 DNS 下直连 HTTPS `/health` 为 200、TLS verify=0。`--service status` 为 running，PID 103。未新增真实微信消息或模型派发。
- 尚未证明：真实微信收发、Linux 实机用户服务、Mac Mini/公司机器正式接入、所有独立 CLI/Claude/Grok 控制、手机网络延迟、长期休眠/断网/掉电、持续自治、压力与灾难恢复。macOS 文件日志轮转未配置。当前单节点交付不等于完整生产保障；未提交、推送或创建 PR。

### 微信账号有效性与授权发送

- 用户明确授权真实微信发送后，复用已有账号及独立私有 Gateway 状态。真实 `pollBatch()` 返回 2 条入站消息，两条发送者均与扫码保存的 `account.userId` 一致，已取得本人对话的回复上下文。未将历史消息转发至 Controller，未提交轮询 cursor，未派发任何会话任务；账号文件保持不变。
- 向该已核实的本人对话发送 1 条固定测试文本，说明香港控制台与 Mac Air 已连接、自然语言完整收发仍在联调。固定 client ID 为 `super-leader:owner-authorization-20261011-01`，没有重复发送。iLink `sendmessage` HTTP 200、适配器正常返回；响应未提供 `ret` 或 `errcode`，没有已读回执，因此只确认请求正常返回，不据此宣称用户已收到或已读。
- token 与 context token 未输出、未上传香港。私有状态位于 `.runtime/wechat-gateway-state.json`。真实 Gateway 常驻轮询和允许名单仍未启用；完整自然语言指挥尚未完成真实微信端到端验收。

### Codex 桌面 Task 目录绑定核查

- 用户另行要求迁移当前 Task 及本项目测试 Task 的项目归属和工作目录。精确目标为当前 `01a0349d-ba7d-7d62-904e-d68272bb1122`，以及 `01a12745-9b1f-7e91-9800-188386bb7574`、`01a12746-0c19-7a81-9da9-149de6d0736d`、`01a1274e-7954-7862-a091-d5251aef0a8b`、`01a1276a-b4b4-7f01-b91f-4a1106687545`、`01a129a9-94b7-7101-ab0f-c9ffaa3e9744`。没有修改关联许多无关任务的 ordinary 项目。
- 桌面项目列表、SQLite 只读查询与原生 `thread/read` 交叉核查：源码已移动，但上述任务仍记录原 ordinary、旧项目路径或 Workspaces 父目录；新项目尚未注册至桌面项目列表。
- 原生协议支持 `thread/settings/update` 的 `cwd`，但本控制连接看到目标均为 notLoaded，已尝试的测试目标返回 `thread not found`。桌面 follower 实现也会透传 `cwd`，不能把此问题误报为协议不支持目录更新。
- 本地桌面 IPC 的初始化首试超时；补齐 `sourceClientId: initializing-client` 后握手成功。随后 `thread-owner-discovery`（version=1、params.hostId=local）对 6 个精确目标全部返回 `no-client-found`，没有发送设置更新或任务消息。诊断连接正常关闭。
- 结果：**Task 绑定迁移 0/6，尚未完成**。未直接改写运行中客户端的数据库/全局状态，未 resume 会话、重启客户端或创建新会话。当前所有项目工具操作显式指定新 workdir；这不等于 Task 默认目录已更新。后续需客户端内操作或经协调的离线维护。
- 轻量复验：`git diff --check` 通过；`node local.mjs --check --controller https://leader.taoai.site` 为 macair connected、22 会话、83 技能、11 命令；原生服务仍为 PID 103。旧源码目录不存在，Gateway 状态权限为 0600。

## 控制台一次性登录与香港 Gateway（2026-10-11）

### 实现和离线验证

- 用户已明确回复“收到了”，确认上一条授权微信测试消息实际到达；该确认不代表自然语言控制全链路已验收。本轮新增需求为微信索取或主动发送一次性控制台链接，1 小时有效、自动登录、地址栏清除凭证。
- 新增独立链接与会话认证：明确配置 `CONSOLE_PUBLIC_URL`，HMAC 派生单次链接，随机登录态，认证表仅保存 SHA-256。浏览器不再输入或持有 Controller 管理 token；Cookie 只授权状态/技能/命令记录 GET，写请求及 Daemon 握手仍需独立 Bearer。
- `get_console_link` 是模型工具，不通过 slash command 或硬编码中文意图分流。真实链接由 Controller 附在最终回复，模型工具结果仅含成功标记/到期时间，历史中的 `#login` 凭证脱敏；业务消息/幂等回执仍可能保存短期链接，不能声称整个数据库无明文链接。
- 主 Agent 独立运行 `node test-console-auth.mjs --run`：真实临时 PostgreSQL 双连接、8 路 HTTP 并发仅 1 次兑换成功、固定 1 小时过期、Cookie 读写权限分离、退出撤销、Controller 重启保留登录态且链接不可重用全部通过。增强后再次运行，新增会话主键冲突导致事务回滚、链接保持可兑换的断言也通过。两个临时容器均清理成功，没有操作正式数据库。
- `pnpm --dir controller run typecheck`、`build`、127 项既有与新增 Leader/存储测试及 `node test-integration.mjs` 全部通过。独立 HTTP 测试首跑在新增测试的 URL 正则处语法失败，不能将此阶段计作最终全套通过；最终回归结果另记。
- Gateway `--establish-baseline` 以原始空消息页为完成条件，未完成则禁止正常轮询；健康检查只读本轮进程状态，不读取微信凭证。基线中断续作、正常状态拒重新初始化、错误脱敏及 CLI 互斥测试已通过。
- 主 Agent 复现裸 URL 的首尾下划线被 Markdown 当强调标记删除（`urlPreserved:false`）；将 URL 作为不透明文本保护，加入 43 字符 token 的首尾/内部下划线回归。修复后 `pnpm --dir gateway test` 28/28、构建通过。CLI/部署联合 `node --test deploy/authorize-wechat.test.mjs deploy/gateway.test.mjs deploy/config.test.mjs local.test.mjs test-live-session.test.mjs test-wechat-model.test.mjs` 35/35 通过。
- Web 审查发现真实入口丢弃 bootstrap token、StrictMode 清理后第二次初始化抢先查询会话的竞态；要求统一共享整个登录初始化过程，而非只共享兑换请求。上线前必须用生产入口真实浏览器验证，不以 `initialToken` 测试注入代替。
- 子 Agent 遇到临时 high-demand 接口错误后按现有文件继续重试；另有子任务返回伪工具调用而未落地，主 Agent 接手真实修改并验证，未将其报告当成已实现。清理了补丁工具遗留的 3 个 `.orig` 临时副本，正式源码与运行数据保留。

### 香港增量部署事实

- 复用现有香港 PostgreSQL 卷与正式数据，没有再次迁移覆盖。账号及已核实本人上下文通过加密 SSH 传至 `.runtime/wechat`，账号文件 0600、状态目录 0700，容器 UID 1000；不将凭证打进镜像。`ALLOWED_CHAT_IDS` 由专用工具 dry-run、apply、幂等复验，只加入本人。
- 维护容器首次因非 root 所有文件及 `cap_drop ALL` 读失败；仅该一次性离线维护容器加 `DAC_OVERRIDE` 后成功，常驻 Gateway 权限不放宽。
- 香港 Gateway 镜像构建成功。建基线前检查本地 Gateway 进程为 0；`--establish-baseline` 返回 `ok:true`、`batchesDrained:1`、`rawMessagesSkipped:0`，时间 `2026-10-11T08:42:03.152Z`。该阶段没有转发或回复历史消息，正常服务启动与真实浏览器结果另记。

### 最终回归与上线验收

- 主 Agent 修正 HTTP 测试 URL 正则语法后，独立执行 `pnpm --dir controller run typecheck && pnpm --dir controller test && pnpm --dir controller build`：19 文件、143 项通过。`pnpm --dir web typecheck && pnpm --dir web test && pnpm --dir web build`：4 文件、23 项通过。Web 使用共享的完整认证初始化 Promise；生产 main 入口不丢弃 token，同 tab hashchange 同样同步清理地址栏。
- 香港首次增量镜像构建失败：远端残留旧版 `web/tests/polling-auth.test.tsx`，其旧 hook 参数为 string，类型检查要求 boolean。同步当前 tests 与构建配置后重建成功；失败期间未替换运行服务。Controller 镜像 manifest list 为 `sha256:47def84192f75263e0a2ecbc155ff947b2b1c55a1b95b5732a77dc7ac75f86dd`；Gateway 为 `sha256:2798cfa5b95fadb4a02d67c95b37e654d673df091241846e43e22af0effa84df`。
- 使用 `docker compose --env-file .runtime/controller.env -f compose.yaml -f deploy/compose.production.yaml -f deploy/compose.gateway.yaml --profile wechat up -d --no-deps controller` 更新控制平面，并用相同配置 `up -d --no-deps gateway` 启动独立网关。未重建/覆盖 PG 卷，未重建 baseline；本地没有重复轮询进程。Controller、Gateway、PostgreSQL 均 healthy。Gateway 健康文件 `last_poll_succeeded_at=2026-10-11T09:05:17.641Z`，`total_error_count=0`，并非仅 Docker starting 状态。
- 正式 HTTPS 独立测试链接：签发有效期约 1 小时；兑换 200、再次兑换 401；`Secure/HttpOnly/SameSite=Strict` Cookie 读取状态 200、签发链接 401；退出 200、旧 Cookie 查询会话 401。更新后状态为 model、macair connected、21 会话、83 技能、11 命令；本轮没有派发会话命令。
- 以已核实本人 chatId 直接调用正式 `/v1/messages` 模拟“给我控制台链接”：真实 gpt-6.1-sol 返回 1 条可兑换链接，耗时 12093ms；兑换 200、退出 200、无 commandId。该测试没有发送微信消息，不冒称真实微信入站全链路通过。
- 使用 ego-browser TaskSpace 30 验证生产入口：初次链接自动登录，URL 为 `https://leader.taoai.site/`，无 token 输入框；bootstrap token 已删除，localStorage/sessionStorage 为 0，document.cookie 无会话凭证。刷新后 `/auth/session=200`，页面显示 macair。
- 浏览器第一次退出点击报 `element is not visible in the viewport`；诊断发现该任务页面 viewport 为 0×0，不是按钮业务失败。仅在自有 TaskSpace 页面设置 390×844 测试视口，snapshot 显示真实控制台、21 会话、11 completed、0 在途，scrollWidth=390。随后真实点击退出：session 401、旧会话数据隐藏；同 tab 设置新链接 hash 后自动兑换、清理 URL，session 200、Storage 0；再次真实退出为 401。测试 TaskSpace 已 `finish({keep:[]})` 关闭，不修改用户页面或共享浏览器配置。本轮没有进行截图验收；浏览器有新版提示，未擅自升级。
- 最后向已核实的本人微信发送全新、未消费的正式链接。固定 client ID `super-leader:owner-console-link-20261011-final-01`，iLink 适配器正常返回；链接失效时间 `2026-10-11T10:08:00.782Z`（北京时间 18:08）。发送脚本只读账号与最新回复上下文，没有轮询或保存旧 checkpoint，不干扰常驻 Gateway；原始链接不写本报告。用户尚未确认本条链接在微信内打开效果，接口成功不等于已读。

## 会话工作台上线与复用验收（2026-10-11）

### 实现与离线证据

- Web 改为按机器分组的会话工作台：搜索标题/目录/模型/ID，常驻真实 model、modelProvider、reasoningEffort、状态及更新时间。历史采用 bounded tail、older 分页、工具延迟展开、安全 Markdown（禁 raw HTML、外图不加载）。草稿按 nodeId/sessionId 仅存内存；历史单飞、切换取消、滚动锚保护，不把历史轮询称为 token 流式。
- Controller 增加 `/v1/sessions/:nodeId/:sessionId/history` 与 `/messages`。后者固定 send 与路径目标，仅接受 prompt/requestId；Cookie 要求精确 Origin、JSON、专用 intent header，派发前重验登录。通用管理写仍禁止 Cookie。发送复用 PG 持久化命令、requestId 幂等，accepted 与 completed 分开，uncertain 不自动重发。
- 独立历史通道绑定 socket 实例、nodeId、sessionId、requestId，核对内层 session.id；Controller 15 秒超时、全局 32/节点 8 并发，Daemon 8 秒/4 并发，取消与断连释放。历史不进入命令 journal，不堵塞心跳。原生查询启用 experimentalApi、显式包含 cli/vscode/appServer 来源；只读 thread/read + thread/items/list，不 resume。
- Daemon 历史只投影公开类型和字段，排除 reasoning/未知类型，UTF-8 文本裁剪且完整响应小于 1 MiB。App 注入输入有时是 functionCallOutput，按工具结果展示，不从正文猜成 user。普通原生 turn 的 userMessage 已在下述真实浏览器验证。
- 主 Agent 独立执行 Controller typecheck/test/build：21 文件、201 tests PASS；Web typecheck/test/build：5 文件、41 tests PASS；Daemon `go test -race ./... && go vet ./... && go build -o bin/super-leader-daemon .` PASS；Gateway 28 tests、节点注册 CLI 16 tests PASS；`node test-integration.mjs` 的临时真实 PG/CAS/隔离/幂等/恢复/Leader 计划与技能记忆断言 PASS，临时容器和进程已清理。
- 一次 Go 命令误从仓库根执行，报 main module 不在目录内；改在 daemon 目录执行后通过，不把错误执行计为成功。最终文案小改由 Web worker 重跑 typecheck、41 tests、build 全部通过；Daemon worker 最后补充 UTF-8/JSON 转义边界后 race/vet 全部通过。临时 native_history_test.go 探查文件已移除。
- 独立安全审查未发现置信度 >=8 的 HIGH/MEDIUM 问题，覆盖 Cookie 写边界、精确目标、派发前鉴权、响应隔离、Markdown 与推理过滤。这是代码审查，不等于完整攻防/生产保障。多个子 Agent 临时 high-demand 错误经重试未恢复，随后使用用户指定模型的替代 worker 完成交付，错误未被当作完成。

### 增量部署与真实使用

- 部署前正式 `/v1/status=200`，macair connected、无 pending/accepted/uncertain。仅白名单源码经 SSH stdin 传香港，不含运行数据、依赖或凭证；compose 使用 `config --quiet`。沿用 PostgreSQL 卷、Gateway baseline、Daemon journal，没有重置/迁移，也没有启动第二个微信 poller。
- 香港构建首次产物 hash 与本地不同；逐文件 SHA256 对比发现远端残留旧 `web/src/components/TokenGateBar.tsx`，本地已删除且无人引用。删除这个精确废弃文件后重新构建，产物与本地一致：`index-DAIySb3K.js`、`index-C00mfKpE.css`。最终 Controller image manifest `sha256:61ca901d90f466d6760469c7078b05780e3e0fb7aa8e4a2cfe363837f1708f2d`。仅 `up -d --no-deps controller`；Controller/Gateway/Postgres 全部 healthy，后两者未重建。
- Mac Air 通过项目二进制 `--service install` 更新既有 LaunchAgent，保留 node-id macair、正式 WSS、原 token-file、state-dir、socket、4 个 skill-root；稳定路径服务 running，PID 39510。没有另外启动 Daemon 或 app-server。
- App 工具创建的专用会话 `01a12a84-2826-7671-8126-9309aacd1a23` 能读取历史，但控制 socket 报 notLoaded；显式 resume 原生拒绝 `already has an active writer`。旧 Skill 测试会话同样拒绝。停止加载尝试，未绕过 writer 锁。产品提示改为“当前控制接口未加载此会话，暂时只读”；打开 App 不保证控制 socket 能发送。
- 在既有原生 socket 创建一个测试 fixture `01a12a91-5777-75e0-8df3-4ee968565997`，标题“控制台专用验收 · 复用后归档”，cwd 为当前 Workspaces 项目、model gpt-6.1-sol、approvalPolicy never、sandbox read-only。保持该测试连接，仅复用这个目标执行两轮真实网页发送。
- 桌面网页点击发送：command `cmd_ccd7d4f9-458f-47b5-a119-3e7325572741` / turn `01a12a95-7f5c-7d41-bb70-c11e1c82d6f6`，accepted 后 completed，返回含 `CONSOLE_WORKSPACE_VERIFIED_20261011` 的 Markdown 标题和列表。页面出现真实 user 1 + assistant 1，显示 gpt-6.1-sol / openai_http / high。
- 同一会话在 390×844 视口通过 Enter 第二次发送：command `cmd_7a908e1b-3441-4899-af88-d0d6a93201ee` / turn `01a12a99-eb4e-7311-8936-ed4a939e1527` completed，输出 `PHONE_SESSION_REUSE_VERIFIED_20261011`；页面 user 2 + assistant 2。独立原生 thread/read 确认两个精确 turn 均 completed、itemTypes 只有 userMessage/agentMessage，无工具/文件操作。正式命令由 11 增至 13，无重复派发。

### 浏览器交互、安全探测与限制

- 复用唯一 TaskSpace 31。首轮 goto 仅改变 hash，旧文档未刷新，等待新搜索框超时；检查实际旧页面后 reload，正确载入新 bundle。不是服务发布失败，也没有重复兑换新 token。
- Cookie 真实 history `limit=1` 两页分别返回 assistant/user，cursor 耗尽；`limit=51` 返回 400。缺少 intent 的发送返回 403，Cookie 通用 `/v1/commands` 返回 401；这些探测均没有新增命令。第一次 notLoaded 探测目标已不在节点快照返回 404，因此不能算有效 notLoaded 验证；改用当前存在的 Skill 专用测试，返回 400 `Target does not support this action`，按钮同时禁用且显示只读原因。
- 真实点击“加载更早的消息”，可见历史条目从 16 增至 33。复用旧 Skill 测试历史，点击工具折叠项成功展开 9231 字符；仅记录长度不复制正文。A/B 切换分别恢复各自草稿且不发送。手机详情隐藏列表、返回后可搜索选中；innerWidth=scrollWidth=390、composerWidth=390，无横向溢出。
- 刷新后 `/auth/session=200`，URL 无 hash/query，localStorage/sessionStorage=0，document.cookie 不含会话凭证。真实点击退出后 `/auth/session=401`、工作台卸载、historyItems=0、storage 仍0。
- 截图标准调用报 `Page.captureScreenshot` timeout；独立 fromSurface=false 返回 `Unable to capture screenshot`；raw 模式重试仍 timeout。未得到截图，不声明像素视觉验收通过。一次截图失败后页面被浏览器适配缩成 720×500，导致桌面搜索框不可见；显式恢复该测试 Page 1440×1000 后继续，未更改全局浏览器配置。微信内置浏览器与真实手机软键盘仍需用户验证。
- 当前会话写入受原生 writer 归属限制。本轮证明的是已加载会话的完整发送链路，不代表所有 App/CLI 会话都能从 Web 操作；跨客户端 writer 协调、Claude/Grok、Linux 实机、Mac Mini、长期断网和生产压力保障仍未完成。

### 清理与后续复用

- 两轮验证结束后，原生 thread/archive 成功归档 `01a12a91-5777-75e0-8df3-4ee968565997`，创建连接及终端测试进程正常退出（0）。该 ID 作为后续优先复用 fixture，项目目录正确；下次确需测试再明确恢复，不抢占 writer。
- App 创建测试 `01a12a84-2826-7671-8126-9309aacd1a23` 已归档；对旧测试先独立 read_thread 确认最后一轮 completed，再归档 `01a12745-9b1f-7e91-9800-188386bb7574`、`01a12746-0c19-7a81-9da9-149de6d0736d`、`01a1274e-7954-7862-a091-d5251aef0a8b`、`01a1276a-b4b4-7f01-b91f-4a1106687545`、`01a129a9-94b7-7101-ab0f-c9ffaa3e9744`。归档列表独立确认这 7 个精确目标存在，历史可恢复；未触碰主任务或用户工作会话。
- 测试登录已退出，`task.finish({keep:[]})` 仅调用一次并成功关闭 TaskSpace 31。保留正式服务、数据库、journal、证据，不保留临时截图或探针脚本，不创建备份。浏览器有更新提示但未升级；未提交、推送或建 PR。
- 清理后独立正式 `/v1/status=200`：macair connected、15 会话、13 命令、0 pending/accepted/uncertain；7 个已归档 fixture 均不再出现在活跃节点快照，两条本轮命令仍为 completed。`git diff --check` 通过；扫描无 `.orig`、`.bak`、一次性原生探针或失败截图文件。
- 尝试向本人微信发送新版说明和一次性链接，固定 client ID `super-leader:owner-workspace-link-20261011-01`；执行退出 1，未确认投递，因此未宣称已发出、未自动重发。仅凭退出码不能定位到具体接口。随后只读诊断确认账号本人 ID/回复上下文存在、模块可加载、Controller URL 正确且 `/health=200`，baseline 仍为 `2026-10-11T08:42:03.152Z`。没有轮询微信或保存 checkpoint；用户可在微信重新索取链接，主动发送这一步仍未验证成功。
