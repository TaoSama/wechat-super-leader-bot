# 原终端控制链路验证

日期：2026-10-12。范围：在 `751cef0` 的输入投递器上接通持久命令、Controller、自然语言单步确认与 Web。仅合成目标；未推送、部署或启用真实终端发送。完整 Super Leader 项目仍未完成。

## 运行验收

结论：合成链路与真实 Web 交互通过；真实 CLI、微信和生产接入未验收。

运行方式：`node verify.mjs --suite integration` 构建三个组件，启动本机临时 PostgreSQL、真实 Controller/Go Daemon、自建 Unix socket 和 WebSocket 中继。中继只接受当次随机合成 token，不发现真实终端、不连接 App、不发微信。终端进程与 journal 均位于自建 `sltc-*` 临时目录。

- 默认不带模式参数时，HTTP 返回 409，宿主收到输入数为 0；准备资格只做读操作，不改变 native loaded。
- 显式 `non-atomic` 下，中文、多行、尾空格与实际投递文本一致。只收到 `input-written`、六字段证明、空 output；无 turnId、无虚构任务完成或私有 socket。
- 错误 proof ACK 后重启，原结果继续重放，输入仍为 1；精确 ACK 后重启，不再重放 pending 结果。重放原 wire command 和八个并发同 HTTP 请求只返回原回执，不写第二次；相同 requestId 改正文返回 409。
- Daemon 和 Controller 分别重启后，PG 中的证明与原记录严格相等；伪造 completed/turn 和更换 request UUID 均不能改变记录。
- 同 pane 换 session 在输入前拒绝。宿主收输入后丢回执时保持 uncertain；重启、重放原 command、生命周期变成 done 都不重发或提升为完成。
- 模拟模型提出单步计划时只返回带“非原子”的预览、0 次写入；确认后只写一次，不创建 Execution。含终端的多步计划被拒绝，随后确认也没有命令。
- 两个 PG 客户端竞争不同 proof，只允许一个胜出；畸形/多字段/错 session/不安全整数/native/read 证明全部回滚；断连、TTL 不降级已写入证明，不进入 native turn reconciliation。

运行输出摘录：

```text
PASS HTTP → PostgreSQL → WS → real Go durable journal → explicit synthetic pane: exact input-written proof, no turn/output/completed; disabled by default; wrong/correct ACK, raw-command and HTTP dedup, both process restarts never resend
PASS same-pane session replacement rejects before input; lost native receipt persists uncertain through restart/raw replay; lifecycle done is not completion evidence
PASS natural-language terminal preview zero writes with non-atomic disclosure → confirmation single input-written; terminal dependency plan rejected with no pending execution
```

## 浏览器实操

执行 `node web/tests/workspace-fixture.mjs --port 0`，使用构建后的 Web，通过 Ego Lite 的同一 TaskSpace 38 操作。fixture 只在 loopback 提供合成 API，浏览器这部分不连接真实 Daemon；不能与上一节混称为浏览器到真实终端的联合验收。

1. 搜索并选中合成终端会话，读到非原子警告，填写中文多行后点击发送。界面显示“输入已写入，执行未确认”；实际合成写入计数 1。
2. 将资格设为 disabled 和 expired，保留非空草稿；发送按钮均禁用，提示分别为默认只读和资格过期，输入计数仍为 1。
3. 切 uncertain，发送第二条输入，页面保留草稿、显示回执丢失并禁用新发送。点击“核查发送状态”仅查询原命令，合成写入计数保持 2。
4. 切换 Leader，已写入回执位于独立分组；“最近完成”仍只有原 native fixture。展开能查看六字段证明和原请求，没有关联 Turn 或最终输出。
5. 390×844 手机尺寸下，页面 `scrollWidth=390`，回执警告、核查按钮和禁用发送可见；桌面 1440×1000 下布局正常。三张截图均实际打开核查。

最后一次成功的计数：

```json
{"latest":0,"older":0,"statuses":0,"sends":2,"contexts":0,"expiredHistoryRequests":0,"planUpdates":0,"mode":"uncertain","terminalInputWrites":2}
```

`statuses=0` 表示由 SSE 取得状态；终端没有发起聊天历史读取。

截图：[桌面回执](web-desktop.png)、[手机存疑状态](web-mobile.png)、[Leader 输入证明](web-proof.png)。

## 回归与审查

- `node verify.mjs --suite unit`：13 checks，exit 0。包含 Controller/Web/Gateway、CLI 工具、Go 全包 race/vet、macOS 和 Linux 构建，以及公开包四场景运行示例。
- `node verify.mjs --suite integration`：6 checks，exit 0。包含真实临时 PG 整链、Compose 配置与一次性登录链接/Cookie；原桌面 owner、历史、有序技能、持久依赖计划、通知的合成回归保持通过。
- Controller 43 files / 584 tests；Web 16 files / 307 tests。新增对应 19 / 27 项终端回归。独立只读审查未发现确证阻断项。
- 六个新增或修改的根脚本/浏览器 fixture 通过 `node --check`；`git diff --check` 通过。

修正与异常均保留：

- 第一轮集成在终端场景通过后，外层重启检查报 `Cannot read properties of undefined (reading 'commandId')`。原因是新 helper 未返回 cleanup wrapper 的结果；补 return 后完整回归通过，没有削弱断言。
- 审查补上了 proposal 入口先清 pending、拒绝不合法终端多步，防止目标离线等早退保留旧授权；ACK 在异步持久回读后再次检查连接 owner，并核对持久状态和精确 proof。
- 规则解析的显式读/发分支定位偏差在发布前修正，增加精确目标、上下文与只读回归。
- 浏览器收尾时主控提前停止 fixture，最后一次冗余 metrics 请求失败；此前 2 次写入与核查不重发的计数已成功记录。确认自有空间后导航空页并完成关闭，没有重试输入。

## 未证明、清理与回退

- 此版本没有运行真实 CLI/微信/模型验收，也没有改变香港镜像、Air/Mini 服务或 App transport。
- PTY 写入仍无法原子绑定原 CLI 进程 incarnation；退出、同类替换及人工输入竞态未封闭。前后检查与持久证明不等于消除此风险。
- 没有可信的终端任务完成关联，因此不能用 idle/done、输入证明或 metadata 标记推进依赖；真实 pane 选择仍待用户明确，不操作默认焦点。
- 本轮仅复用两个协作单元，均已结束。浏览器 fixture 正常退出 0、TaskSpace 38 关闭且没有保留页面；临时 PG、Go 进程、socket/journal 由验收入口收尾。截图是保留的交付证据，不是备份。
- 生产未变，无需生产回退。后续若启用，应停止派发并撤销 terminal-send-mode，保留原 journal/PG 幂等记录，不能删除记录或换 requestId 强行重试。
- 建议后续把“待验收能力”与“可自动解锁依赖的证据”作为独立接口合同持续检查；本轮没有修改全局规则或技能。
