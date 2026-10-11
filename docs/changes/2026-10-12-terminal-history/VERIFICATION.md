# 原 CLI 历史读取验收

日期：2026-10-12（Asia/Shanghai）。范围为本地源码，基线 `727a738`；不含正式发布、真实账号或真实 CLI 验收。

## 结果

PASS：原生 Go 进程通过既有终端协议的精确 pane/可信会话引用，读取显式配置目录的可见记录，再经真实 Controller HTTP/WS 返回。Web 新来源沿用刷新与滚动、保留阅读位置，且不产生发送资格或完成证明。

两个复用协作单元分别负责读取器、Controller/Web；主控独立检查源码和实际接口。无新增 Task 或 Agent。

## 真实应用接口

`test-terminal-history.mjs` 已接入 `node verify.mjs --suite integration`。入口编译并启动真实 Go main/生产 OpenDaemon，使用自建 Unix socket、三种 JSONL 记录、真实 Controller 和临时 PostgreSQL。不是直接 import 内部函数，也不连接用户终端。

1. 默认无目录：发现三会话但无 historySource，历史 HTTP 502；配置明确目录后 source=terminal-transcript，working 会话可读，loaded=false、无 sendAvailability。
2. 每提供方 limit=2：最新 public-4/5 → 较早 public-2/3 → 最早 public-0/1。追加 public-6 后新页可见，原旧页 items 完全不变，外部 cursor/context 不包含文件路径。
3. 推理哨兵不出现在响应；只有 user/assistant，Grok 类型 transcript_chunk，turnId 为空且无 status。
4. 跨会话 context、已读前缀改写、文件 inode 替换、删除、相同 pane 内会话引用替换、重连后的旧 context 均返回 HTTP 409。恢复原绑定后旧 context 仍不可复活；显式无 context 新读恢复。
5. 文件删除后新读明确不可用，无终端画面或 native 控制接口兜底。终端 RPC 仅 ping/agent.get，agent.prompt=0；读取前后 PostgreSQL 提供的 commands 快照完全一致。

关键运行输出：

```text
PASS terminal history real Go → WS → Controller/PostgreSQL → HTTP: default off, three explicit providers, working agents readable, public text only, fixed old pages after append, opaque context, no loaded/send/turn/completion invention
PASS history invalidation: cross-session, prefix rewrite, inode replacement, deletion, same-pane binding replacement and reconnect → HTTP 409; explicit reset recovers; no screen fallback, zero terminal writes and zero new commands
```

## 浏览器操作

运行 `node web/tests/terminal-history-fixture.mjs --port 0`，同一浏览器空间 39 操作构建后的 Web。此处后端是明确的 loopback 合成 API，与上一节的真实 Go 链分开验收，不能混称浏览器直达真实 CLI 的全链验收。

- 1440×1000 打开 Claude 会话，初始 30 条（120–149）；向上连续滚轮自动读取 3 页，达到 120 条（30–149）。未点击“加载更早”按钮。
- 阅读旧记录时追加一条，出现“有新消息 · 跳到最新”；锚点 claude-record-59 的 top 追加前后均为 273px，条数变 121。
- 触发 409：121 条保留，明确提示重新读取；3 秒观测窗口 latest=37、older=3、contexts=1 均不变，失效请求仅 1 次。点击重置后变为最新 30 条，新 context 数为 2。
- 撤销 marker：保留 30 条，3 秒无新增历史请求（latest=38）。恢复后原 context 可继续；观测设为过期，再次保留 30 条并停止读取（latest=39）。
- 切换未配置 marker 的会话：显示原说明页，3 秒内 latest/older 仍为 39/3，零历史请求。
- 切换 Grok，390×844 显示“文本片段（非完整轮次）”；页面宽与文档宽均为 390，无横向溢出，发送按钮仍禁用。
- 最终计数：latest=51、older=3、contexts=3、expiredHistoryRequests=1、sends=0、terminalInputWrites=0。

截图：

- [桌面失效提示与保留历史](desktop-expired.png)
- [手机宽度与片段语义](mobile-chunks.png)

观察：上下文失效提示位于固定详情头部，阅读旧消息时仍可直接找到重置入口；普通来源暂停说明在历史滚动内容顶部，若正停在底部需向上查看原因，当前头部刷新会禁用、过期状态显示未知。后者是可进一步改进的可见性，不影响暂停语义。

## 回归与审查

- `node verify.mjs --suite unit`：13 checks PASS；Controller 44 文件/601 测试，Web 18 文件/342 测试，Gateway 104 测试；Go race/vet 与 macOS/Linux 构建通过。
- `node verify.mjs --suite integration`：最终 6 checks PASS，包含上述新真实接口、原桌面与终端输入回归、持久计划、Gateway 合成通知及一次性登录验证；临时 PostgreSQL 清理成功。
- 最终额外 `cd daemon && go test -race ./...`：全部 PASS（client 23.343s，transcript 10.381s）。
- 定向配置/服务测试覆盖：默认关闭、非法/重复目录、缺 selector、`--codex-home` 不扩大授权、LaunchAgent XML roundtrip、systemd escaping、非法配置拒绝前零副作用。未安装或重启系统服务。
- 读取器负向覆盖：symlink/FIFO、目录/文件替换、重复候选、身份、非法/半行 JSON、重复字段、Unicode、页预算、并发、TTL、取消和 reset。目录 50000 项上限未创建 50001 文件压力样例；Linux 仅交叉编译，未实机读取。

独立审查发现并修复：

1. marker 读取途中撤销：读取前后确认来源，旧 context 409，不发布无来源的历史。
2. 程序化坏配置：OpenDaemon 在创建 journal 前返回错误；无持久化副作用。
3. 409 后旧 token 复活：删除失效 binding 后再释放请求 gate；原 marker/绑定恢复也必须新 context。新增前/中途撤销回归与真实 HTTP 换绑恢复测试。
4. 跨层 provider/类型校验：同一目标响应不得切换提供方，新来源只接受两种 transcript 类型；不把终端画面包装成消息。

## 限制、清理与回退

只读原文件，不保证完整语义重建；Claude 分支/重复流与 Grok 完整消息边界未实现。单文件≤32 MiB、行≤2 MiB，每次读取最坏约三次有界扫描加目录枚举，未作大目录持续刷新性能验收。

真实 pane/socket/记录目录尚未明确配置；未发送真实 CLI 输入，未验证真实微信或手机微信内置浏览器。没有更改 App transport、启动 app-server、resume 会话、抢 writer、改 Codex DB 或重启 App；未 push 或部署。

浏览器空间 39 已 finish 且无保留页面，两次自有 fixture 均正常退出 0；两名协作单元已结束。临时 PostgreSQL、Go 进程和 socket/记录目录由验收入口清理。保留两张交付截图，不创建备份。

关闭方式：移除明确的 terminal-history-root 参数即可禁用新来源，不删除历史文件或 journal；本轮没有更改正式服务参数，所以正式环境不需回退。

建议将“缺共享 socket 不等于必须重启应用；核实原宿主控制、历史来源、完成证明三条独立链路”作为后续编排审查项；未擅自修改全局规则或技能。
