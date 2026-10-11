# 工作台体验与微信查询修复

## 范围与架构

仍为单一 Controller（TypeScript）编排权威、独立微信 Gateway（TypeScript）、Web（React）以及宿主机原生 Daemon（Go）。保留 PostgreSQL、Gateway checkpoint 和 Daemon journal；不新增隔离 worker、app-server 或第二个微信 poller，不改变已有会话 writer 归属。

本轮用户要求：界面易读、Super Leader 与会话分区、实时状态、连续滚动历史，以及修复微信“看看现在有什么 active 的任务”失败。使用指定的前端设计、UI/UX 与 Agent 编排技能；新增独立 Codex Task 严格限定为两个，分别只读复核查询链路和实时/历史边界。

## 实现

- 浅暖背景与克制强调色，Super Leader/会话双主导航；Leader 最近 50 条真实指令分为需要处理、执行中、最近完成，支持节点/状态筛选与展开回执。
- 会话三行摘要常驻标题、状态、预览、模型、项目简称和相对时间；技术字段折叠。草稿按会话保留，切换主导航暂停隐藏历史读取。
- Daemon 2 秒单飞发现，内容变化主动上报；观察时间单独变化不产生额外上报。慢发现/技能扫描不阻塞正常心跳、命令和历史，失败保留上次成功快照。
- Controller 认证 SSE 推送，与状态 GET 使用同源 DTO；共享快照、合并更新、连接/缓冲限制、独立鉴权及注销关流。Web 单飞轮询兜底、断流退避、隐藏/离线暂停恢复。
- 会话历史 2 秒持续快照读取，不是 token 流式；分页排队/去重、顶部自动加载、首可见 DOM 锚点保位、离底新消息提示。2000 条硬窗口保留较早 1970 条与最新 30 条，裁剪缺口显式展示，可重新读取最新页。
- 回执加固：精确 thread/turn ID 绑定；缺失、非法 UTF-8、孤立 surrogate 或替代字符不被标为受理成功，uncertain 不自动重发。

## 微信失败证据与修复

- 香港日志 `2026-10-11T11:16:25.518Z` 的 `TimeoutError` 与数据库同一请求失败记录（更新 `11:16:25.513Z`，请求摘要 `204ac1d18437`、`model_failure`、无待执行计划）关联。
- 旧 Leader 整轮预算 24 秒，模型单次预算 20 秒，Gateway 30 秒；日志没有各模型轮次耗时，不能将“两个具体调用分别耗时多少”写成已证实事实。
- 修复为单次模型调用 60 秒（含该次 HTTP 重试）、模型工具循环 90 秒、claim 105 秒、Gateway 单次 HTTP 105 秒。父级整轮截止优先，90 秒不包括所有数据库操作，不宣称整个 HTTP 链路有绝对 90 秒截止。
- 增加 `list_sessions(status="active")` 与只读查询指引；模型选择工具仍非形式化意图判定，实际派发必须经过后续显式确认。
- 临时模型 HTTP 错误有限重试，遵守 Retry-After；已识别额度/鉴权错误不重试。新增脱敏错误类别、参考编号、轮次和耗时，失败不伪装成“没有任务”。Gateway 丢失响应重试沿用原消息 ID。
- Retry-After 超过单次剩余预算时立即返回带原 HTTP 分类的暂不可用错误，不空等、不提前重试、不把上游 502 抹成 timeout；合法等待期间若父预算到期也保留已知 HTTP 原因。
- `list_sessions` 附带筛选前状态分布、节点/会话覆盖数、未知和未加载数、观测时间范围及 `completeTaskCoverage: false`。提示词明确 active=0 仅表示已观测快照未发现 active，notLoaded 不等于 idle。
- Gateway 单消息处理预算 380 秒：Controller 最多 3×105 秒、整份回复发送总预算 60 秒、checkpoint 余量 5 秒；每次微信发送请求 15 秒。健康检查区分有截止时间的 polling/processing 阶段与真实持久化进度。停止后只完成当前消息，不启动下一条；未完成整批不提交 cursor，重启按已处理 key 去重续接。容器退出宽限 600 秒，未改变 checkpoint 结构或重建基线。

### 生产真实模型模拟

均在正式 Controller `/v1/messages` 使用已授权本人 chatId，模型 `gpt-6.1-sol`。这些请求不经过微信入站，也没有外发微信消息：

| messageId 后缀（共同前缀 `workspace-active-query-20261011-`） | 结果 | 证据 |
| --- | --- | --- |
| `fix-01` | HTTP 200，但业务失败，32888ms | 第一版仍为单次 20 秒。`11:39:33.865Z` 第二次模型调用收到 HTTP 502、Retry-After 60000ms；`11:39:53.685Z` 被预算截断，参考编号 `61e565608446`、modelSteps=2、toolCalls=1、lastModelMs=20003。不是已经证明第二次推理自身耗时过长。 |
| `fix-02` | 间隔超过 60 秒后成功，10599ms | 同一原句、不同消息 ID；commandId=null、命令 15→15。快照有 14 notLoaded + 1 idle，促使增加覆盖说明，避免误报全局无任务。 |
| `fix-03` | 最终版本成功，12326ms | `2026-10-11T11:54:08.755Z`；运行时单次预算确认为 60000ms、HTTP 200、commandId=null、pendingPlan=false、数据库命令 15→15、macair 在线。 |

第三次原句为“看看现在有什么 active 的任务”，返回：已观测的在线会话未发现 active；覆盖 1 个在线节点、15 个会话，其中 1 idle、14 notLoaded；未加载不能认定为空闲或没有任务，因此不能确认所有机器都没有运行任务。查询没有生成执行计划或向会话派发新指令。

## 独立检查闭环

两个独立 Task 未写源文件、未读取凭证、未操作生产：

- `01a12ab3-70dc-7f20-95fe-8c112c80a931`：查询预算、claim、幂等与生命周期。
- `01a12ab3-7344-7d22-9906-2fbb72891001`：SSE、认证、分页与滚动。

发现并修复：单个悬挂鉴权阻塞全局广播；慢健康查询延迟处理已返回的 401/403；手动刷新定时器重复；慢分页期间继续滚动被旧锚点拉回；“跳到最新”后迟到补页不能跟随底部；长请求预算与 Gateway 健康/退出生命周期不匹配。原独立复现与新增定向回归通过，未降低原安全断言。两个辅助 Task 完成复核后已归档，没有创建第三个独立 Task。

## 主任务独立验证

最终补丁由主任务独立复验：

| 命令 | 结果 |
| --- | --- |
| `pnpm --dir controller test` | 26 文件、240 tests 通过 |
| `pnpm --dir controller run typecheck && pnpm --dir controller run build` | 通过 |
| `pnpm --dir web test && pnpm --dir web run build` | 8 文件、73 tests；类型检查和构建通过 |
| `pnpm --dir gateway test && pnpm --dir gateway run build` | 生命周期配套改动后 35 tests、构建通过 |
| `node --test deploy/gateway.test.mjs deploy/config.test.mjs` | 7/7 通过 |
| `cd daemon && LIVE_CODEX_SESSION= LIVE_CODEX_HISTORY_SESSION= go test -race ./... && go vet ./... && go build -o bin/super-leader-daemon .` | 通过，未访问真实会话 |
| `node test-integration.mjs` | 临时真实 PostgreSQL CAS、坏 ID 更新事务不变、双节点隔离、幂等、重启恢复、Leader 计划/技能/记忆通过；临时容器清理 |
| `node --test test-live-session.test.mjs local.test.mjs` | 14/14 通过 |
| `git diff --check` | 通过 |

新增模型预算回归覆盖：两次调用 13+25 秒成功；单次 60 秒包含重试；第一轮 45 秒后第二轮由整轮 90 秒优先截止；502 的 Retry-After 超剩余预算不白等、不伪称重试并保留 HTTP 分类；active 查询返回筛选前覆盖统计。

浏览器使用本地 `web/tests/workspace-fixture.mjs`，仅绑定 loopback，合成 240 条消息，所有发送禁止，不连接真实 Controller/Daemon/微信。TaskSpace 32 复用：

- 桌面 1440×1000：自动顶部翻页 30→60 条，首可见锚点偏差 0px；模拟实时尾部到达后 61 条、偏差仍 0px，出现新消息提示。
- Leader 三组/模型展示、切换主导航保留草稿、按模型搜索命中一项通过。
- 手机 375×812：页面无横向溢出，composer 底部为 812、历史区域 306px。
- 短横屏 812×375：修复前 composer 底部 436.5，修复后底部 375、body 高 375、历史区域 116.5px、scrollWidth 812，没有横向溢出。
- 真实点击退出后工作台卸载、历史条目 0、localStorage/sessionStorage 合计 0。
- 初始浏览器视口 0×0；仅对自有测试 Page 设置设备视口后 DOM/交互可用。标准截图及独立原生 `fromSurface:false` 均超时，未取得截图；不能声称像素级视觉验收通过。浏览器提示新版本，未自行升级。

## 上线与清理状态

最终切换前确认无 pending/accepted/uncertain 命令、无有效 Leader claim；正常停止并排空 Gateway 后再次检查，再仅更新 Controller 并恢复 Gateway。PostgreSQL 原卷、Gateway checkpoint/baseline 和 Daemon journal 保留；未运行新的基线，不另开微信 poller。

- 最终 Controller 镜像：`sha256:8f3f16d9bd3c23da40a02e6e3bcdaec326778e152064310d031ab8709b49a7a0`。
- Gateway 镜像：`sha256:bc9a16fbc213c1971c380257e6d056462bb454f2fb5cc226e7b53fde2d6cb356`。
- 切换后 Controller/Gateway/PostgreSQL 均为 healthy；公网 `/health` 在 `2026-10-11T11:54:13.358Z` 返回 ok。Gateway 新进程 `11:53:34.382Z` 启动，`last_poll_succeeded_at=11:54:12.077Z`、totalErrors=0、processedMessageCount=0；健康命令通过，未把空轮询当成微信业务验收。
- MacAir 原生服务运行 PID 77782，最终模型验收时节点 connected、15 个会话。未向运行中的用户会话写入。
- 生产 Web：`index-BN2yOlSw.js` / `index-BC53hMzi.css`。浏览器真实验证一次性链接登录、URL 无 hash/query、本地 storage 为 0、SSE 显示实时连接、15 个会话；只读主任务历史 19→34 条，未加载会话发送禁用原因正确。退出后 `/auth/session` 返回 401。
- 两个辅助 Codex Task 已归档；其他实现 Agent 已完成或终止于工具错误，无仍运行的后台实现任务。没有新建或恢复真实验收会话。
- 浏览器 TaskSpace 32 已退出测试 Cookie 并通过 `finish({keep:[]})` 关闭；两次 fixture 服务均通过 `/fixture/stop` 正常退出，无残留 fixture。未创建 `.runtime/verification` 或任何备份；未取得截图的事实保留。

回退须同样先排空 Gateway 并确认无在途命令/claim，再恢复明确的旧镜像并验证节点与微信轮询；不得清空卷、checkpoint 或 journal。旧 Controller 镜像 `sha256:2bdeac39b45068822e4a20ef65516ff99706bc2890800519dbd4c4b8c423d428` 仍为单次 20 秒预算，不含本轮最终覆盖说明，不应作为解决此 bug 的默认回退方案。

仍需用户最终确认微信内实际入站回复与内置浏览器使用体验；DOM 模拟不替代手机软键盘与像素视觉验收。桌面 owner 写入、全部 CLI/Claude/Grok、Mac Mini/Linux 实机及长期生产可靠性不属于本轮已证明能力。
