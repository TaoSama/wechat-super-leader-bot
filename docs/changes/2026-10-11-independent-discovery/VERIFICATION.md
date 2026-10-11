# 会话发现与桌面探测收口

验证日期：2026-10-11，最终本机核验约 13:44 UTC。此记录只覆盖本轮增量，不替代此前部署证据。

后续增量已改用纯文件元数据发现并完成两机临时 probe，详见 [文件发现验证](../2026-10-11-rollout-discovery/VERIFICATION.md)。下文保留 SQLite 实验撤回时的状态，不作为当前源码不支持独立发现的结论。

## 结论与方案边界

此前“需要先配置共享后端并重启桌面应用”的方案不再作为接入前提。用户没有批准该环境变更，本轮没有启动共享后端、更改桌面连接方式或重启应用。

会话接入须区分三种能力：

- 会话发现：取得可信会话身份及元信息，不代表正在运行或可发送。
- 原进程控制：使用已有运行时的 socket / pane / owner 路由，状态与发送归属于用户当前看到的会话进程。
- 持久化恢复：新建进程后按原 ID 恢复历史，不等于附着原执行者，不能悄悄作为发送降级。

Super Leader 的编排权威及 Controller / 原生 Daemon / Web 分工保持不变。后续仍优先连接已有运行时，未知能力明确只读；不通过隔离 worker 或隐式 resume 冒充原会话控制。

## 保留的改动：桌面发现公平调度

原发现过程每个 30 秒窗口都从排序列表首部开始。最多 32 个并发 owner 查询，每个默认 5 秒超时；前部大量无响应 ID 会耗尽窗口，后部在线 ID 可能永久无法被查询。这个问题在现有控制接口的大列表中也存在，不依赖本轮索引实验。

当前新增 `daemon/pkg/codex/desktop_schedule.go`：

- 曾观察到的 ID 与其他 ID 分成两个不重叠队列，1:1 交替查询。
- 两队列各自保留游标，只有请求实际发送成功才推进；下轮从上次位置继续。
- 游标 ID 被删除时从字典序后继继续，不重新回到首部。
- 只保存会话 ID，不缓存 owner 或发送权限；每轮仍重新确认 owner。
- 单次 Snapshot 不修改长期 Watch 的调度状态。

`desktop_schedule_test.go` 覆盖混合队列、全为已知会话、游标删除、跨队列变化、连接失败、Snapshot 隔离，以及 96 个静默 ID 前缀下尾部 owner 在后续窗口被发现并重新订阅。测试使用合成 Unix socket，无真实发送。

## 撤回的实验：本地 SQLite 索引

最初实现了独立索引 worker、元数据合并、`--codex-home` 和服务参数。但独立 writer 的 WAL 测试证明：`mode=ro&readonly_shm=1` 仍可在 checkpoint 后创建空 WAL 文件。仅事前检查文件不能消除并发删除的时间窗口。

因此全部撤回 catalog 实现、CLI 开关、服务参数、probe 降级、合并/读取接线和 SQLite 依赖，不保留不可安全启用的实验入口。详细复现与源码位置见 [SQLite 只读验证证据](SQLITE-READONLY-EVIDENCE.md)。失败实现本身已删除，不可从当前源码直接运行原实验测试；文档保留重建方式，不创建备份。

本轮此前曾只读查询两机数据库 schema；新 Go catalog 没有用于真实数据目录。发现零写边界失败后取消了计划中的 Mac Mini 新二进制 probe。当前生产路径仍通过已有控制接口发现 ID，故 Mini 控制接口缺失的问题尚未解除。

## 主任务验证

命令在仓库 `daemon/` 下执行，除注明者外：

| 命令 | 结果 |
| --- | --- |
| `go test -race ./pkg/codex -run 'TestDesktop(Schedule\|WatchShort\|SnapshotDoes)' -count=1` | 通过，2.445s |
| `go test -race ./...` | 全部通过，client 17.332s / codex 9.123s / config 3.018s；其余包通过或命中缓存 |
| `go vet ./...` | 通过 |
| `go build -o bin/super-leader-daemon .` | 通过 |
| `file bin/super-leader-daemon` | Mach-O 64-bit arm64 |
| `GOOS=linux GOARCH=amd64 go build -o /dev/null .` | 编译通过，不代表 Linux 实机验收 |
| `git diff --check`（仓库根目录） | 通过 |

独立审查重复 5 次 targeted race 通过（3.894s），未留下未解决 finding。所有协作 Agent 已完成本轮工作，未新建独立 Codex Task。

本机使用新二进制做只读 Snapshot 探测：

```sh
./bin/super-leader-daemon --probe \
  --desktop-sock /Users/luwentao/.codex/ipc/ipc.sock
```

结果：macair 15 个会话，控制接口 loaded/sendable 均为 1；桌面观测可用 9 个，其中 active 2 个，未知或不可用 6 个；没有诊断错误。输出只汇总数量，不记录会话正文。这证明当前快照读取仍正常，跨窗口轮转由合成 socket 回归验证；不能以这一次快照声称覆盖长期休眠/重连或所有会话的控制能力。

## 未完成、清理与交付范围

- 新二进制只构建到项目 `daemon/bin`，未更新 Air 运行服务、未部署香港或安装 Mini 节点。
- Mini 独立发现、原桌面 owner 写入与跨机完整读写验收尚未完成；不能把本轮修复标为整个项目完成。
- 未发微信或任务消息、未创建验收会话、未读写凭证、未更改系统配置或备份；临时测试 socket/数据库及 writer 子进程已由测试回收。
- 保留项目既有脏树与运行数据，没有盲目整体提交或覆盖旧目录。撤回/回退仅涉及本轮新代码，不要求恢复用户数据。
- 建议今后将“只读数据源必须测缺失 sidecar 和独立 writer”加入工程验证约定；本轮只记录建议，不修改全局规则或技能。
