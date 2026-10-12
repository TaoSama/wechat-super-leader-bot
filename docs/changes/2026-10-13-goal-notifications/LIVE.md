# 目标通知现场验收

日期：2026-10-13（Asia/Shanghai）；以下现场时间使用2026-10-12 UTC。范围为已发布 `0548d05..80c1ee1` 的2个提交（1产品、1文档），不重复上一轮合成测试。本轮仅新增运行证据和文档，没有修改产品或正式配置、重启服务。

## 结论与真实边界

- **原会话目标执行与通知持久化 PASS**：一次确认、一次真实原 owner 派发、两次模型决策；精确完成输出与 HTTP、PostgreSQL、App 原会话记录一致。
- **微信投递成功验收未通过**：正式唯一 Gateway 自然领取通知并尝试发送，但持久回执为 `uncertain`，结构化日志分类为 `ILinkSendMessageError`。不能宣称接口受理、手机收到或已读。
- 入站预览与确认都是直接调用正式 Controller 的**服务端模拟**，没有操纵微信客户端或把模拟说成用户手机发来的消息。外发尝试由正式 Gateway 使用已有账号/context 执行，未手工 claim/send。
- 首次预览资格不满足时安全拒绝；当时没有创建目标、命令或通知。新目标不是为补发旧通知而重建；旧通知全行摘要不变，两条未知投递都永久保留原 attempt，不重发。

## 前置与冻结范围

20:18:34预检：23命令、39消息、1 completed目标，无未决命令/聊天claim/pending计划/pending目标/active计划或目标。节点 A与节点 B在线，Leader模型为 `gpt-6.1-sol`。原通知为 `uncertain`，attempt=`8a7867ea-6f56-5178-9f5f-bcb00da766fb`，完整行MD5=`537cf0f6717e31646438df3c8349af51`。

复用 `c0863a5b-311c-5ab9-997b-be2e24fffb18`，正常解归档并通过App精确导航打开；不创建新会话、不改transport、不启动后端、不抢writer。冻结范围仅 demoair / desktop-owner / skills=[]；最多1次派发、2轮决策、5分钟。原会话只输出 `WECHAT_GOAL_NOTICE_OK`，不调用工具、文件、网络或其他会话。

首次模拟消息 `goal_notice_live_20261013_preview` 于20:20:10返回明确资格拒绝。之后只读socket预检使用现有诊断入口：

```sh
LIVE_CODEX_DESKTOP_SOCKET=/Users/developer/.codex/ipc/ipc.sock \
LIVE_CODEX_DESKTOP_SESSION=c0863a5b-311c-5ab9-997b-be2e24fffb18 \
LIVE_CODEX_DESKTOP_READINESS_DIAGNOSTIC=1 \
LIVE_CODEX_DESKTOP_READINESS_EXPECTED=ready \
go test ./pkg/codex -run '^TestLiveCodexDesktopReadonlyReadinessDiagnostic$' -count=1 -v -timeout=20s
```

在 `daemon/` 执行，连接真实既有socket，只读、不创建dispatch身份；这是现场协议诊断，不是合成单测重跑。结果：settings普通会话/已恢复、snapshot idle、0 requests、0未确认、10条已记录turn/0非终态，ready=true，17ms。该会话已重新归档，不能直接重跑后把无owner误判为回归。

20:21:09正式HTTP报告ready，随后以稳定消息ID `goal_notice_live_20261013_ready_preview` 重提尚未创建的预览；20:21:57返回完整冻结目标。20:22:17使用 `goal_notice_live_20261013_confirm` 只确认一次。没有绕过资格判断。预览模型仍在约束中加入“只创建待确认预览、用户确认后才派发”，确认后动作实际正常执行；未在确认后改写授权。

后台资格的generation变化、30秒重新探测、observer重建及共享槽可能影响可用窗口，是代码已证明机制；缺少本次后台job阶段日志，不能将其中任一项认定为本次首次失败的根因。

## 精确执行与外发证据

| 项目 | 结果 |
| --- | --- |
| 目标 / 通知ID | `173ca1c7-339d-5298-adcd-fb0ce858adb1` |
| commandId | `cmd_fac88188-1ee1-46d7-8bf2-5c8cfbd420a0` |
| 原 owner turnId | `06d8ed09-b026-57f1-8cf8-09104461c77a` |
| 精确输出 | `WECHAT_GOAL_NOTICE_OK`，21字符、未裁剪 |
| 输出SHA256 | `df331549f5036bbf3c6aedd3379580235d54def96d56470d5b5b831440794056` |
| App记录完成 | 20:22:30；只有userMessage与agentMessage，无工具项 |
| 目标完成 / 通知生成 | 20:22:38.776；同ID、source.type=goal、kind=completed |
| Gateway领取 | 20:22:55.366；attempt=`71138a3a-90d5-5834-b922-e86ea115df32` |
| 微信回执 | 20:23:19读取为uncertain，后续复查同attempt |

正式HTTP：`GET /v1/status`、`GET /v1/commands/cmd_fac88188-1ee1-46d7-8bf2-5c8cfbd420a0`、`GET /v1/notifications/173ca1c7-339d-5298-adcd-fb0ce858adb1`；管理凭证仅内存加载，不在命令参数或日志输出。独立App读取核对相同turn与完整回复，不仅依赖Controller的完成判断。

只读PG事务交叉检查：目标完成/无lease，确定性requestId、唯一command、固定路线、冻结input.prompt与实际命令相等，next→complete两次决策，最终evidence引用准确command/turn/全文SHA256；HTTP与PG通知对象一致。20:24:05验证器输出 `durable-goal-notification-proof-PASS`，该名称仅说明记录一致性，**不是投递成功**。

脱敏日志证据：

```json
{"event":"notification_send_failed","notificationId":"173ca1c7-339d-5298-adcd-fb0ce858adb1","attemptId":"71138a3a-90d5-5834-b922-e86ea115df32","errorType":"ILinkSendMessageError"}
```

此分类可由缺少严格成功码或显式错误码触发；未保留原始响应，不能进一步区分，不能猜测context过期或认定网络问题。没有放宽成功标准、重试外发、重建目标或改写回执。已询问用户手机是否收到，未获反馈；即使手机收到，也不覆盖原接口的uncertain证据。

边界探测：20:26:22读取通知上线前的旧目标通知，仍返回404，没有补发或回填；正式Web返回200及同一 `/assets/index-D0G0MZ4s.js`。20:26:33重复只读核查，新通知仍为同attempt的uncertain、全部保留摘要相等，没有因查询重新发送。

## 数据保留与清理

新增恰为1条完成命令、3条模拟消息（1次拒绝、1次预览、1次确认）、1个完成目标、1条uncertain通知。共24命令（22 completed/2 failed）、42消息、2 completed目标；无未决命令或授权。以前的完整命令摘要 `e49587b2320849a25bf9fb6081c0899b`、旧目标摘要 `bdf2d9b607f5523de6aa09dd5e32a1f2`、原计划摘要 `50d9fd2580e6ee3999c0ec9803d8d52f` 及旧通知完整行MD5全部不变。

20:24:31正式状态已不含fixture；App归档成功，返回主任务，未删除任何会话记录。Controller/Gateway仍是 `0230727`，原PG容器保留，三者healthy/restarts=0。Gateway保持同一run、基线时间 `2026-10-11T08:42:03.152Z`、1个context及原checkpoint；pollErrors=0只表示入站轮询，不覆盖上述外发失败。没有新增账号、基线或进程。

临时验收脚本曾误用sessionId筛选状态DTO的id字段，以及camelCase读取snake_case的checkpoint字段；已按真实schema修正并独立复查，没有因此改动产品或checkpoint。脚本/临时目录在证据落盘后删除；仅保留文档，未创建备份或新Task。两个复用协作者均已结束。

## 用户当前问题与公开仓库边界

筛选与长历史修复、用户真实微信链接兑换的既有证据见 [历史发布验收](../2026-10-13-history-source/VERIFICATION.md)，本轮没有重复修改或把旧验证计为新增。`gh repo view --json visibility` 仍为PRIVATE。公开前定位到 `docs/changes/2026-10-12-authorized-release/` 下4张图：

- `history-fix-verified.png`：非验收会话私人标题、预览和目录线索；主控已直接查看确认。
- `history-context-expired.png`：真实用户名、绝对路径和操作记录。
- `plan-state-rejected.png`：真实会话标题、指令和机器状态。
- `plan-state-confirmed.png`：验收会话/计划/命令标识和部署状态，不等同凭证。

它们仍被HEAD跟踪，引入提交 `ef32a2f` / `08c3b74` 均在可达历史。只删当前文件不能避免历史公开。仍等待用户明确选择清理这些历史后公开，或明确允许信息随历史公开；没有擅自重写历史、强推或创建另一个公开仓库。产品 `0230727` CI 38301190490与文档 `80c1ee1` CI 38302709098均已通过双平台验证，不代表完整跨机目标完成。
