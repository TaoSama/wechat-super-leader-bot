# 原桌面历史验收

日期：2026-10-12。范围：本地源码的原 owner 已记录历史读取、固定来源分页、取消、失效恢复及大快照冷启动路由。未部署远端 Controller/Web 或已安装 Daemon。本轮没有新提交；HEAD 仍为 `8fc6114`，仓库原有迁移脏树保留，不能把整个未提交迁移都归为本轮改动。

后续同日修复已统一 observer/control/history 入站为 32 MiB，并补充控制资源预算。以下旧 16 MiB 失败与冷启动结果保留为该轮事实，当前边界和后续复验见 [大快照验收](../2026-10-12-desktop-frame-budget/VERIFICATION.md)。

## 结论

限定上述范围 **PASS**：真实既有桌面会话只读读取成功；真实 Controller/PostgreSQL/Go Daemon 与模拟桌面 owner 的端到端链路成功；真实浏览器验证旧页加载、保持阅读位置、409 停读与显式恢复成功。这不等于所有 CLI、跨机宿主、远端线上或微信最终验收通过。

实现及资源契约见 [TECH.md](TECH.md)。编排使用两个已有协作单元，分别负责历史 reader 和跨层/UI，主任务独立验收；后续复用同一单元检查 owner 证明，不新增任务。没有更换 App transport、重启应用、启动 app-server、恢复线程、修改 Codex 数据库、向真实会话发送消息或创建备份。

## 真实只读边界验证

精确目标为主任务 `b3b881ff-1039-58a6-b55f-d74a65602646`，连接既有 `/Users/developer/.codex/ipc/ipc.sock`。测试默认跳过，必须同时提供三个 opt-in 环境变量；不读取其他会话正文，不打印消息正文。

从 `daemon/` 运行：

```sh
LIVE_CODEX_DESKTOP_SOCKET=/Users/developer/.codex/ipc/ipc.sock \
LIVE_CODEX_DESKTOP_SESSION=b3b881ff-1039-58a6-b55f-d74a65602646 \
LIVE_CODEX_DESKTOP_HISTORY=1 \
go test ./pkg/codex -run '^TestLiveCodexDesktopReadonlyHistory$' -count=2 -v

LIVE_CODEX_DESKTOP_SOCKET=/Users/developer/.codex/ipc/ipc.sock \
LIVE_CODEX_DESKTOP_SESSION=b3b881ff-1039-58a6-b55f-d74a65602646 \
LIVE_CODEX_DESKTOP_HISTORY=1 \
go test ./pkg/client -run '^TestLiveDesktopHistoryColdRoute$' -count=1 -v
```

最终直接 reader 两轮分别 1.34s、1.12s，退出 0：

```text
readonly existing owner history: first=3 older=3 latest=3 source=codex-desktop; stable generation; no message bodies logged
```

冷启动验收 1.91s，退出 0：先从无 owner 的 unavailable 占位开始，经真实 Watch 发现精确 owner；16 MiB 状态观察器拒绝大快照后，正常 `Daemon.ReadHistory` 路由仍选独立历史 reader。原生控制接口明确禁用，不能静默 fallback。

```text
state snapshot unavailable; checking whether validated owner discovery survived
cold route: source=codex-desktop first=3 older=3 latest=3; stable context; native loaded=false preserved; no send or journal
```

该测试使用合成的 native `notLoaded/loaded=false` 元数据以证明历史读取不会改写控制权；不声称它是对真实 native 控制状态的探测。上下文和游标保持稳定，旧页不与最新页重叠。测试结束 Reset/Close，关闭订阅，无测试线程或命令 journal 产生。

## 失败、修正与重试证据

1. 初次真实读取 0.01s 返回 `History request failed`：错误要求 response.version=1。真实 discovery 返回 success 但无 version；独立读取应用归档中 response 构造也确认无该字段。改为 requestId/method/owner 绑定，请求版本及 stream version 仍严格检查。
2. 随后返回 unavailable：只读 schema 探针确认 ordinary/resumed/目标身份均正确，帧 header 为 **16,931,802 bytes**，超过旧 16 MiB（16,777,216）。历史专用 read/raw 上限调整为 32 MiB，其他 reader 保留 16 MiB。超限只读 header 即拒绝。未放宽普通线程/身份/完整性验证。
3. 32 MiB 后有一次 `History request timed out`（5.64s）。按临时接口失败重试，没有提高预算。第二次 schema 诊断读到 **29,036,281 bytes** 的完整 snapshot，约 1.47s 完成投影，revision=6024、公开 items=4879，随后真实读取通过。最终去掉诊断代码后又连续两轮成功；一次超时的具体外部原因仍未证实，不宣称永久消除超时。
4. 检查冷启动发现：owner 仅在成功投影 snapshot 后才发布，且已有 unavailable 占位会吞掉新 OwnerID。Watch 现在发现合法 owner 后先发布空的 unavailable 证明；client 合并保留该证明，同 owner 留陈旧投影，换 owner 清空旧模型/时间/状态。不会授予 fresh/available/send。上方真实冷启动验证覆盖此问题。
5. 最初集成退出卡住：history stream 对非幂等 cleanup 重复调用，已改为单次清理。仅对本轮新建且正常终止未退出的测试子进程 PID 40815 使用 SIGQUIT，原 App/服务未操作；harness 退出并清理临时资源。后续多轮集成正常结束。observer 虽有两处 cleanup，但其先 cancel 的顺序不同，没有证明存在同一死锁，不做无依据改动。
6. Reset 正常取消曾输出 closed connection 退订 deadline 警告；现仅在 context 尚未取消时记录真实退订失败。最终两轮真实读取不再出现取消误报。
7. Web 409 提示原在滚动容器顶部，用户读旧页或底部时看不到。已移到固定详情头部，只保留一个恢复入口；修正前后截图在下方。

临时 schema/帧诊断 helper 已移除，仅保留两个简洁 opt-in 验收入口。没有保存原始 snapshot 或私有正文。

## 真实跨层运行

仓库根目录运行 `node test-integration.mjs`，最终退出 0。启动独立临时 PostgreSQL、真实 Controller、真实 Go Daemon，只连接合成 owner；未访问微信或向真实会话发消息。

关键输出：

```text
PASS real Go history: response-before/after patch ordering; complete older pages; active owner read; fixed context incremental updates; one full load; revision gap → HTTP 409; explicit new context recovers; no native metadata rewrite or sends
PASS HTTP → PostgreSQL → WS → real Go Daemon → simulated original desktop owner; model snapshot and patch preserve native facts; ready with native loaded=false; exact native turn and output; busy veto; duplicate request no resend
```

同时通过 PostgreSQL CAS、精确 turn 绑定、两节点隔离、认证、去重、断连不确定性、重启恢复、技能引用和记忆持久化。模拟 response 故意省略 version，防止再次依赖不存在的真实字段。

## 浏览器实际操作

运行最终构建的 `node web/tests/workspace-fixture.mjs --port 0`（loopback 合成数据，发送禁用），使用真实浏览器操作，不接生产账户。最终资源 `index-cV4b8yj-.js` / `index-CCN2n49u.css`。

- 向上滚轮触发旧页，metrics older=1，context 不变。
- 阅读旧消息时新增合成消息 240：scrollTop **286.5 → 286.5**，首条消息 180 保留，没有拉回底部。
- 使 context 失效，已读内容保留，最新请求计数停止增长；旧 cursor 不被送入新 reader。
- 固定头部显示一个恢复按钮；点击后建立新 context，提示消失，最新读取恢复。
- 375×812 手机宽度无横向溢出，按钮完整可见；812×375 横屏无横向溢出，按钮可用，但历史区仅 26.4px，错误态阅读空间仍拥挤，不能声称横屏阅读体验完善。
- 退出登录后历史节点=0，localStorage=0，sessionStorage=0。

最终 fixture metrics：`latest=70, older=1, statuses=0, sends=0, contexts=3, expiredHistoryRequests=3`。浏览器空间已 finish，fixture 通过 `/fixture/stop` 正常退出 0。

截图：

- [修正前提示不可见](hidden-expiry-before.png)
- [桌面失效恢复入口](history-expiry-desktop.png)
- [手机竖屏](history-expiry-mobile.png)
- [手机横屏及剩余阅读空间](history-expiry-landscape.png)

## 回归命令

主任务最终独立执行：

| 命令 | 结果 |
| --- | --- |
| `cd daemon && go test -race ./... -count=1` | 全部通过；client 22.540s，codex 13.153s，另 6 个有测试包通过 |
| `cd daemon && go vet ./...` | 退出 0 |
| `cd daemon && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build ./...` | 退出 0；只是交叉编译，不代表 Linux 真实桌面验收 |
| `node test-integration.mjs` | 上述全链路通过，退出 0 |
| `pnpm --dir controller test` / `typecheck` / `build` | Controller 最终源码 30 文件、369 测试通过，类型和构建通过 |
| `pnpm --dir web test` / `typecheck` / `build` | Web 最终源码 12 文件、210 测试通过，类型和构建通过 |
| `node --check test-desktop-route.mjs` | 退出 0 |
| `git diff --check`、本轮 Go 文件 `gofmt -l` | 无输出 |

Controller/Web 的独立验证发生在最后一次 UI 修正后；此后只改 Go 和文档，未重复已验证工作。协作额外覆盖 Reset/连接错误 race ×10、history/frame race、owner discovery 先于超大 header、非法 owner、7 种 unavailable 合并、CLI 不误路由和发送权限不提升。

未跟踪源码空白检查扫描 166 文件，发现 `controller/src/config.ts:79` 尾随空白，不在本轮改动范围，保留未改；不把 `git diff --check` 描述为全仓新文件无问题。

## 清理、剩余限制与撤回

- 最终测试 runner 正常退出；`docker ps --filter name=super-leader-test- --format '{{.Names}}'` 无输出。临时浏览器、fixture 进程及协作测试目录已清理，保留截图与文档证据。
- 原 `.runtime/desktop-owner-acceptance/commands.db` 及固定命令 `desktop-owner-20261011-01` 未改、未删、未换 ID 重发。生产 PostgreSQL、Gateway checkpoint/baseline、微信 token 未动。
- 私有 IPC 仍依赖已核实 App 版本；snapshot 没有 nonce，不因此取得发送 freshness/原子受理保证。普通 CLI、其他宿主和不同 App 版本需要独立适配/验收。
- 状态 observer/send 仍限 16 MiB，大会话可能显示状态不可用/禁止发送，而 32 MiB 历史 reader 可独立工作。历史超过 32 MiB 明确报超限；不应通过静默换源或返回部分历史掩盖。
- 只承诺 owner 完整已记录历史，不含尚未记录的 UI 暂态。完整加载可能填充 owner 缓存，外部 waiter 取消不保证取消 owner 内部加载。
- 本轮没有运行服务变更，无需重启或回滚线上服务。撤回源码时需按本轮文件/契约成组处理，不能清空整个脏树或删除既有 journal。后续部署需单独确认；未声称整个 Super Leader 项目已完成。

建议后续经用户批准，将“无 version 的真实 response、超大首快照、首次 owner 证明与完整加载 revision”加入项目验收规范；本轮未修改 CLAUDE.md、rules 或 skills。
