# 桌面运行状态观测与 active 查询

## 目标及边界

修复微信原句“看看现在有什么 active 的任务”的查询链路。前一轮已修复模型预算与错误分类（[证据](../2026-10-11-workspace-experience/VERIFICATION.md)），本轮补足控制接口 `notLoaded` 无法反映桌面正在执行的问题。没有把控制未加载当空闲，也没有恢复会话、抢 writer、另起 app-server 或发送测试任务。

架构不变：TypeScript Controller 唯一编排、独立 TypeScript Gateway、React Web、宿主机原生 Go Daemon。桌面观察只补充只读事实；不接通桌面 owner 的写入接口。沿用原 PostgreSQL、微信 checkpoint/baseline 与 Daemon journal，不创建备份。

## 双源契约

原 `status/loaded/capabilities/observedAt` 保持控制 socket 的事实，另增：

```ts
desktopObservation?: {
  status: "active" | "idle" | "unknown";
  observedAt?: string;
  availability: "available" | "unavailable";
  source: "codex-desktop";
}
```

仅当 control 为 notLoaded/unknown、desktop available、观测时间非未来且距今不超过 45 秒时，用 desktop active/idle 得到只读 `executionStatus/statusSource`。明确 control 状态不被覆盖。微信筛选与统计、Web 列表与详情采用同一规则；notLoadedCount 仍反映控制覆盖限制。Web 没有新 SSE 事件时也会在到期后重新计算，不一直显示旧 active。发送、计划与 Daemon 校验仍只信原控制字段。

Go 观察在独立 worker 内；已有 2 秒 control discovery、命令、历史与心跳不等待桌面快照。失败保留上次状态和原时间、availability 变 unavailable；无成功观测则 unknown 且不生成时间。当前会话列表变化时 cancel+join 旧订阅后重建；不接纳已删除目标的迟到结果；嵌套缓存深拷贝。正常窗口结束立即重新订阅，不额外等待失败退避；真实失败仍退避。

## 协议与诊断证据

依据当前本机桌面 `26.1007.30912` / build 20156 的内部 owner/follower 协议；不是官方稳定 API。可复核锚点及信封见 [路由研究](../2026-10-10-control-plane/DESKTOP_ROUTING.md)。

- 只读主会话 snapshot：`2026-10-11T11:58:26.322Z`，revision 1、9,318,795 bytes、active。
- 连续增量：`12:00:41.931Z` revision 2 snapshot，`12:00:46.093Z` 收到 base 2→revision 3、785 bytes patch。
- 首次 Go 全列表 probe 两次失败：第一次 IPC i/o timeout，增加阶段诊断后定位到 `desktop thread-owner-discovery response: ... i/o timeout`。不能用这些失败宣称“桌面不可用”。
- 单目标 gated live 测试在 `12:12:42.297592Z` 返回 active（0.28 秒），证明主任务链路可用；批量实现由串行超时改为单连接有界发现，每项 5 秒超时只影响该项，不打断 framing。
- 修复后完整 probe：`12:19:00.495Z`，6980ms，15 会话。主任务 `b3b881ff-1039-58a6-b55f-d74a65602646`：控制仍 `notLoaded / loaded=false / capabilities=[read]`；桌面 `active / available`、observedAt=`12:18:55.794988Z`。观察到 1 active、6 idle、8 unavailable；unavailable 不等于已证明目标无 owner。

实现采用单 reader + 容量 1 事件 channel，最多 32 个未决 discovery；初始 snapshot 后消费 revision 连续的 Immer patches，只持久保存 runtime status。帧上限 16 MiB，30 秒订阅窗口，退出先有界退订再关连接并 join reader。超限、坏身份、坏 patch、revision gap 使观察不可用；不伪造状态。订阅期间可能延迟 owner 自动卸载，这是内部 follower 的生命周期影响，不是 writer 接管。

## 主任务验证

| 命令 | 结果 |
| --- | --- |
| `pnpm --dir controller test && pnpm --dir controller run typecheck && pnpm --dir controller run build` | 27 文件、265 tests，类型检查与构建通过 |
| `pnpm --dir web test && pnpm --dir web run build` | 9 文件、100 tests，类型检查与构建通过 |
| `cd daemon && go vet ./... && LIVE_CODEX_SESSION= LIVE_CODEX_HISTORY_SESSION= LIVE_CODEX_DESKTOP_SOCKET= LIVE_CODEX_DESKTOP_SESSION= go test -race ./... && go build -o bin/super-leader-daemon .` | 全部通过 |
| `daemon/bin/super-leader-daemon --probe --desktop-sock /Users/developer/.codex/ipc/ipc.sock` | 真实只读 15 会话查询通过，未访问 Controller/微信、未写入会话 |

Go vet 曾指出 desktop worker 的 cancel 并非静态可证明覆盖所有循环路径；已在每轮尾部显式 cancel，完整 vet/race/build 重跑通过。测试期间一次与子 Agent 尚未完成的测试接口改动重叠导致编译失败；接口统一为包内实例 ownerTimeout 后全量复跑通过，没有降低断言。

测试覆盖：完整/分片/短写帧、非法长度/UTF-8/JSON、身份与版本、revision、坏路径/操作、10 MiB 快照不保留历史、乱序 discovery、silent 不阻塞有效订阅、迟到 success 不附着到错目标、32 个 pending 上限与补位、半帧取消/退订/join、control 不受慢 desktop 阻塞、目标变化单飞、深拷贝、45 秒/未来时间/无时间/失联降级、离线/陈旧/未加载禁发送、desktop idle 不授权 propose_plan、多个观测依次过期。

沿用已有两个实现/审查 Subagent；没有新增第三个独立 Codex Task。子 Agent 回报之外，主任务独立运行上述完整测试并阅读相关实现。

## 上线验收

两次切换均先检查无 pending/accepted/uncertain 命令与有效 Leader claim，正常停止 Gateway 后再次核查，再更新 Controller 与原生 Daemon，最后恢复原 Gateway。两次更新都保留 PostgreSQL 原卷、Gateway baseline/checkpoint 和 Daemon journal。

首次模型验收 `desktop-active-query-20261011-verify-01`：`12:27:26.495Z`，HTTP 200、20671ms，已正确查询到 1 个 active；模型随后多调用了 read_session，并在原生连接关闭时未读到最新输出。命令记录 15→16，新增项明确是 `action=read,status=failed`，不是 send；send 总数保持 11。原测试把任何命令增量视为失败，因此该轮整体验收没有通过；没有把 HTTP 200 冒充完成。Daemon 另有 `12:26:53Z` heartbeat TCP write timeout 日志，但没有证据证明两种连接错误的具体共同网络原因。`12:28:55.121Z` 节点和桌面 active 已自动恢复，没有修改网络配置。

据此收紧 list_sessions/read_session 工具说明与系统提示：仅列举 active/运行任务，完成必要分页后直接回答；用户明确要求具体进度/最新输出时再读。没有增加句式硬路由或取消 read 功能。新增单测只证明提示传输与脚本工具路径，不声称模型选择具备形式化保证。

最终原句验收 `desktop-active-query-20261011-verify-02`：

- `2026-10-11T12:32:13.154Z`，正式 `/v1/messages`、已授权本人 chatId、`gpt-6.1-sol`、HTTP 200、12053ms。
- 回复明确“当前查到 1 个 active 任务”，列出 demoair、本主会话、gpt-6-astra 和来源“近期桌面观测 active；控制接口仍 notLoaded”。覆盖 1 个在线节点、15 个会话（1 active、7 idle、7 notLoaded）；保留 14 个控制未加载与覆盖不完整说明。
- 命令总数 16→16，无 commandId、无待执行计划（按实际 `leader_states.data.pending` 检查）。未额外读取详情，未派发执行指令；未经过微信入站，也未外发微信消息。
- 同时主任务仍为 `status=notLoaded,loaded=false,capabilities=[read]`，桌面 `active/available`、observedAt=`12:32:08.234466Z`，只读选择为 `active/codex-desktop`。
- 返回目录仍是原会话保存的 `/Users/developer/Documents/ordinary`；本次没有隐式迁移运行中会话的原生 cwd。源码、构建与服务路径均为 Workspaces 项目目录。

最终部署与健康：

- Controller 镜像：`sha256:7be950779c0083f2c743050e58024e9b3c80d0c3c46ca588b2785bfccc9a6562`。
- Gateway 镜像不变：`sha256:bc9a16fbc213c1971c380257e6d056462bb454f2fb5cc226e7b53fde2d6cb356`。
- Web：`index-zAmEtKWf.js` / `index-BC53hMzi.css`；三个容器均 healthy。
- demoair LaunchAgent PID 4148，原参数保留，新增显式 `--desktop-sock /Users/developer/.codex/ipc/ipc.sock`。原 journal inode 46471457、262144 bytes、0600 保持不变，未换 state-dir。
- `12:32:57.980Z` 再次核验 15 会话、主会话 active/available，只读字段不变；观测时间更新到 `12:32:54.584009Z`，跨正常窗口续订仍工作。
- Gateway 于 `12:31:53.687Z` 启动，`12:32:56.693Z` 检查 healthy、lastPollSucceededAt=`12:32:55.699Z`、totalErrors=0、processedMessages=0，健康命令 exit 0。空轮询不是微信业务验收。
- 公网 `/health`：`12:33:15.671Z` 返回 ok。
- 公网认证 `/v1/events`：`12:34:03.477Z` 返回 HTTP 200 和真实 status SSE（15 会话），主会话桌面 active/available、observedAt=`12:34:00.714149Z`，控制只读字段仍保留；读取后主动取消并关闭连接。

本轮未新建或恢复验收会话、浏览器页或后台 fixture；测试连接均退订/关闭，临时测试目录由 fixture 清理。两个复用 Subagent 均完成，无仍运行的辅助实现任务。生产服务与验证文档保留。

## 截图问题收口复核

`2026-10-11T12:41Z` 复用现有代码与原句验收记录，没有重复部署、重新发送模型请求或扩展桌面发送功能。主任务重新执行：

- `pnpm --dir controller test`：27 文件、265 tests 通过；`pnpm --dir controller run typecheck` 通过。
- `pnpm --dir web test`：9 文件、100 tests 通过。
- `cd daemon && go vet ./... && LIVE_CODEX_SESSION= LIVE_CODEX_HISTORY_SESSION= LIVE_CODEX_DESKTOP_SOCKET= LIVE_CODEX_DESKTOP_SESSION= go test -race ./...`：通过（Go 测试缓存命中，没有作为新的 live 验收）。
- `git diff --check`：通过。
- `curl --fail --silent --show-error --connect-timeout 5 --max-time 15 https://leader.example.com/health`：返回 `status=ok`，服务时间 `2026-10-11T12:41:05.630Z`。

健康检查只证明服务可达；业务结论沿用上文 `verify-02` 真实模型验收，不将本次健康检查冒充新的微信端到端验证。用户可在微信重发截图原句完成入站与手机展示确认。

### 追加：HTTP 错误体断流分类

独立复核用本地合成响应发现同类 P2 边界：上游已经返回 HTTP 502 / JSON / Retry-After 60 秒，但读取 JSON 错误体挂起或断流时，原实现丢失已知 HTTP 分类，退回 timeout/processing；断流仍会出现泛化的“本次模型处理未成功”。没有证据证明原截图恰好经过这条分支。

`controller/src/leader/model.ts` 现在保留已知 HTTP 状态与尝试次数；可选错误体读取失败不覆盖分类、不泄露响应或异常内容，并停止自动重试（错误体不可读时不能排除额度失败）。复用审查 Agent 仅修改 `controller/tests/leader-query-bug.test.ts`，新增挂起到截止与立即断流两项回归，均断言暂不可用、无伪称重试、无计划/命令副作用。

- 主任务独立运行 `pnpm --dir controller test && pnpm --dir controller run typecheck && pnpm --dir controller run build`：27 文件、267 tests、类型检查与构建全部通过。
- 只传输已核对旧 SHA256 的模型源文件；没有重新发布 Web、重装 Daemon或改动凭证。切换前后排空检查均为 activeCommands=0、activeClaims=0、总命令16；正常停止/恢复原 Gateway，保留所有持久化数据。
- **当前 Controller 镜像**（取代上文旧部署记录）：`sha256:8ba13f9f05033c769f4a17f24e36d15201c74c98187099ffdff021110a18759e`；Gateway 镜像仍为 `sha256:bc9a16fbc213c1971c380257e6d056462bb454f2fb5cc226e7b53fde2d6cb356`。
- 线上源文件 SHA256 与本机一致：`1c372178201a2c487cf9649c57835dcb80a99eaef358f1e554a6d45179b878c1`。
- `2026-10-11T12:48:57Z` 在已部署镜像内导入实际构建的 `HttpLeaderModel`、注入合成 502 响应，挂起和立即断流均返回 `category=http,httpStatus=502,attempts=1`，通过回复与重试断言；不访问外部模型、不操作会话。
- `12:48:58.837Z` 正式状态接口：demoair connected、15 会话、主任务桌面 active/available，原 control notLoaded/loaded=false/read 权限不变；命令仍16。
- 公网 `/health` 于 `12:48:56.704Z` 返回 ok；Controller/PostgreSQL/Gateway 均 healthy，Gateway 健康命令 exit 0、累计错误0。健康结果不代表微信业务回复已验收。

两个复用协作 Agent 均已结束；没有新增独立 Task、测试会话、临时服务、备份或残留脚本。

## 尚未证明与回退

真实微信入站和用户手机展示仍需最终确认；正式接口模型模拟不等于微信端到端。桌面 owner 发送、所有 CLI/Claude/Grok、Linux 实机、跨机时钟漂移和长期负载尚未由本轮证明。

若桌面协议升级不匹配，可用原完整维护参数去掉 `--desktop-sock` 后按正常安装流程关闭观察（先确认无在途命令）；控制、journal 与数据库保留不动。仅回退追加的错误分类补丁可恢复镜像 `sha256:7be950779c0083f2c743050e58024e9b3c80d0c3c46ca588b2785bfccc9a6562`，但会重新引入错误体断流分类缺陷；整体观测功能回退镜像为 `sha256:8f3f16d9bd3c23da40a02e6e3bcdaec326778e152064310d031ab8709b49a7a0`。两者均须先排空 Gateway 与确认无有效 claim，不清空卷或重建基线。
