# 大快照与控制资源验收

日期：2026-10-12。范围仅限本地大快照入站、控制资源预算及回归。限定范围 **PASS**；没有更新远端 Controller/Web 或已安装 Daemon，不能将本地结果描述为线上生效或完整 Super Leader 生产验收。HEAD 仍为 `8fc6114`，本轮未提交，原有迁移脏树保留。

实现契约见 [TECH.md](TECH.md)。按编排技能复用两个已有协作单元负责帧边界、控制资源及独立审查；主任务另行复跑回归和真实只读，不以协作报告替代验收。

## 真实既有 owner，只读

精确目标：主任务 `b3b881ff-1039-58a6-b55f-d74a65602646`；socket `/Users/developer/.codex/ipc/ipc.sock`。没有 Dispatch、turn/start、resume、journal claim 或新测试会话；不记录消息正文。

从 `daemon/` 运行：

```sh
LIVE_CODEX_DESKTOP_SOCKET=/Users/developer/.codex/ipc/ipc.sock \
LIVE_CODEX_DESKTOP_SESSION=b3b881ff-1039-58a6-b55f-d74a65602646 \
LIVE_CODEX_DESKTOP_READINESS=1 LIVE_CODEX_DESKTOP_HISTORY=1 \
go test ./pkg/codex -run '^TestLiveCodexDesktop(ReadonlyModelObservation|ReadonlyHistory|ReadonlyReadiness)$' -count=1 -v

LIVE_CODEX_DESKTOP_SOCKET=/Users/developer/.codex/ipc/ipc.sock \
LIVE_CODEX_DESKTOP_SESSION=b3b881ff-1039-58a6-b55f-d74a65602646 \
LIVE_CODEX_DESKTOP_HISTORY=1 \
go test ./pkg/client -run '^TestLiveDesktopHistoryColdRoute$' -count=1 -v
```

结果：模型 1.33s、busy 预检 2.12s、历史 3.57s、冷启动路由 4.00s，均退出 0。模型通过独立 settings 与 stream snapshot 交叉核对：

```text
readonly model observation: model="gpt-6-astra" provider="openai_http" effort="ultra" status="active"
readonly original-owner preflight: large snapshot parsed; active target remains rejected; no dispatch
readonly existing owner history: first=3 older=3 latest=3 source=codex-desktop; stable generation; no message bodies logged
cold route: source=codex-desktop first=3 older=3 latest=3; stable context; native loaded=false preserved; no send or journal
```

追加重复引用防护后再次单独运行 `TestLiveCodexDesktopReadonlyReadiness`，1.41s PASS。该真实目标处于 active，预检到 busy 即返回；重复 canonical 引用的拒绝由下面的合成测试证明，不虚称对真实会话制造了重复历史。冷启动测试中的 native unloaded 为明确合成事实，用于确认只读路由不会提高权限。

## 跨层回归

仓库根目录 `node test-integration.mjs` 最终退出 0。临时 PostgreSQL、真实 Controller、真实 Go Daemon，只连接合成桌面 owner，不启动微信。17 MiB padding 使实际 snapshot 大于旧 16 MiB 上限，小于 32 MiB；公开 status 不含该字段。

```text
PASS >16 MiB original-owner snapshots across observer, readiness, dispatch preflight, exact-turn inspection and history; private padding omitted from public status
PASS real Go history: response-before/after patch ordering; complete older pages; active owner read; fixed context incremental updates; one full load; revision gap → HTTP 409; explicit new context recovers; no native metadata rewrite or sends
PASS HTTP → PostgreSQL → WS → real Go Daemon → simulated original desktop owner; model snapshot and patch preserve native facts; ready with native loaded=false; exact native turn and output; busy veto; duplicate request no resend
```

同轮也通过 PG 双客户端 CAS、turn 绑定竞争、两节点隔离、鉴权、断连 uncertain、重启后精确回查且不重发、技能引用和记忆持久化。模拟 owner 总共只受理一次合成发送；这不是本轮真实原会话发送证据。

## 结构、并发与引用边界

- 32 MiB 入站精确边界接受；超 1 byte 只读 header 拒绝。16 MiB 出站精确边界接受；超 1 byte 零写入。
- >16 MiB observer 与 readiness fixture 通过，公开观测不携带历史正文。
- 250000 个节点精确接受、超 1 拒绝，object/array 语义一致；64 层精确接受、超 1 拒绝。密集未知字段与 items 不能绕过结构预算，检查先于 typed 展开。
- 合法未知 `1e1000` 不被结构扫描误当成坏 JSON；坏语法及已知 typed items 的不合法 float64 仍拒绝。
- readiness、PrepareSend/Dispatch、InspectTurn 共享两槽；等槽取消、dial/初始化/discovery/preflight 失败释放、并发重复 Close、Dispatch 保持原槽、Close 解阻塞均通过。
- 1 MiB 正文 + 10000 个重复索引先通过字节/节点/深度预算，再在展开时返回静态错误与 nil turns；覆盖同 island、跨 island、限时 InspectTurn 和槽释放。单份 canonical、暂态/canonical 两份相同表示仍通过，不同表示仍拒绝。

主任务最终独立执行（引用防护落盘后）：

| 命令 | 结果 |
| --- | --- |
| `cd daemon && go test -race ./... -count=1` | 全部通过；client 21.859s、codex 27.761s，另 6 个有测试包通过 |
| `cd daemon && go vet ./...` | 退出 0 |
| `cd daemon && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build ./...` | 退出 0；不代表 Linux 实机接入验收 |
| `node test-integration.mjs` | 上述全部断言通过，退出 0 |
| `node --check test-desktop-route.mjs` | 退出 0 |
| 本轮 Go 文件 `gofmt -l` / 定点尾随空白扫描 | 无输出 |
| `git diff --check` | 无输出；多数 Go 文件仍未跟踪，不据此声称全仓新文件已审查 |

Controller/Web 未改代码，沿用上轮最终 369/210 项及类型/构建验证，不重复运行或累加计数。

## 失败与修正证据

1. 修正前真实模型读取 0.61s 失败，修正入站后 1.06s 通过；最终独立 settings/snapshot 比较如上。
2. 最初结构 scanner 以 token 计数，真实预检两次失败；诊断明确 `structuralLimit=true`，非 deadline、坏 JSON 或 frame 超限。原因是把 key/closing 也计入，偏离 history 的节点定义。保持 250000 的原节点预算，修正为值/容器节点（root=0），不是提高限额；真实 busy 预检随后通过。
3. 大帧 Go fixture 首次 race 曾因连接建立后编码 17 MiB 占用原 3 秒测试预算而失败；改为建立连接前预编码。未改变生产或测试预算，最终全 race 通过。
4. 大帧跨层 fixture 两次断管；增加无正文诊断后第三次得到：`write EPIPE; client=super-leader-desktop-controller; lastRequest=thread-follower-start-turn; lastWrite=broadcast:thread-stream-state-changed:snapshot:17826857; following=true`。模拟端先 ACK，客户端正常结束请求后仍写大 snapshot。改为先发布状态事件再 ACK，仍要求控制 reader 消费大广播，不忽略 EPIPE、不提高超时；修正后两轮跨层测试通过，最后一轮包含引用防护。
5. 独立审查识别到共享索引的工作量放大：29 MiB item + 100000 重复引用可只占 31,809,100 bytes / 200,027 nodes，却让旧 InspectTurn 累计序列化约 6.08 TB。数字为合成结构计算，不运行破坏性负载。新增重复索引拒绝与上述有界回归；没有吞掉引用错误或降低精确比较要求。

## 分配与进程 RSS

Apple M5、darwin/arm64；合成 29 MiB 文本，不读取私有历史。命令为 `go test -c -o <本轮临时目录>/codex.test ./pkg/codex`，然后每个子项单独进程执行：

```sh
/usr/bin/time -l <本轮临时目录>/codex.test -test.run '^$' \
  -test.bench '^BenchmarkDesktopSnapshotProjection$/observer-29MiB$' \
  -test.benchtime=1x -test.count=1 -test.benchmem
```

将末段替换为 `control-29MiB` / `two-controls-29MiB` 得到另外两项。一次样本，仅是观察值，无分位数或稳定容量承诺：

| 合成投影 | ns/op | B/op（累计分配） | allocs/op | 测试进程最大 RSS，bytes |
| --- | ---: | ---: | ---: | ---: |
| observer | 275034709 | 30422136 | 95 | 136232960 |
| 单 control | 177513541 | 127952568 | 628 | 197951488 |
| 两个 control 并行 decode | 161258250 | 255894672 | 924 | 275726336 |

`B/op` 不含 fixture 构造，不含 transport frame/Params 复制；RSS 包含 Go runtime 和合成 fixture 构造。双 control 只是并行 decode，不是网络或整个 Daemon 的压力测试。observer 临时 raw 字段复制和 control 分配放大仍存在，不能把以上约 130/189/263 MiB 当成生产上限。引用防护在 recordedTurns 阶段，这个 decode-only benchmark 不覆盖该阶段；其工作量由专用引用测试验证。

## 清理、交付与未证明事项

- 两轮成功 runner 正常清理自身临时 PG 容器、Go 子进程、socket 和测试 journal。单独 benchmark 二进制与本轮空临时目录已精确删除；测量结果保留在此文，未创建备份。
- 原 `.runtime/desktop-owner-acceptance/commands.db`、生产 PG、Gateway checkpoint/baseline、微信 token 未动；未重发原固定测试命令。本轮不创建或归档任何真实会话。
- 未改变 App transport、系统配置或运行服务；源码撤回需逐文件保留原迁移脏树，不能 reset 整仓或删除数据。当前无线上变更需要回滚。
- 私有 IPC 版本依赖、snapshot 无 nonce、非原子发送预检、>32 MiB 会话限制、其他宿主/CLI 和微信真实入站验收仍未解决。更新远端与已安装 Daemon 的询问尚未获得确认，本轮不部署。
- 完整项目验收仍以 [ACCEPTANCE.md](../2026-10-10-control-plane/ACCEPTANCE.md) 为准，不标记整个目标 complete。

建议经用户批准后将“入站帧预算与出站分离、节点定义一致、共享索引工作量”加入项目验收规范。本轮未改 CLAUDE.md、rules 或 skills。
