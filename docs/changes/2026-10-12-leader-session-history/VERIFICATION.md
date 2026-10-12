# 自然语言会话历史查询验收

本轮开始于 2026-10-12（Asia/Shanghai）。变更前基线为 `08c3b74`，目标与边界见 [TECH.md](TECH.md)。这是具体会话查询接线，不代表跨机、真实 CLI 或全目标已完成。

## 根因与实现

`LeaderOrchestrator.read_session` 原来提交 `CommandService` 的持久 `read` 命令。Daemon 对仅在文件目录发现的原桌面会话返回文件元数据；已有 Web 历史路由却没有被微信模型工具复用。因此“Web 能读历史”并不保证“微信问具体进度能读到内容”。

现改为原 `hub.readHistory` 的临时只读请求，显式检查在线、精确目标及 read capability，不要求 loaded。90 秒整轮取消信号贯通原历史通道。最多 8 条近期已记录内容，复用正文 1000 Unicode 码点 / 3000 JSON 字符裁剪，总投影最多 11000 JSON 字符，优先保留连续较新记录，完整性、来源、时间与裁剪明确标注。不产生 command、聊天 commandIds、发送资格或完成证明。

终端模型查询只接受已配置的 `terminal-transcript`，无来源直接说明不可读，不改读屏幕。显式管理诊断 read 的既有终端快照保留，未加旧工具兼容分支。Daemon、Web、Gateway、协议与数据库 schema 均未修改。

## 本地验证

| 命令 | 实际结果 |
| --- | --- |
| `pnpm --dir controller exec vitest run tests/leader-orchestrator.test.ts tests/session-observation.test.ts tests/terminal-session.test.ts` | 61/61 PASS |
| `pnpm --dir controller exec vitest run tests/leader-session-history.test.ts` | 主控独立 36/36 PASS；同文件另经独立严格 TypeScript 检查 |
| `pnpm --dir controller test` | 最终 49 files / 739 tests PASS（23:57:04）；此前 734 项版本也通过，后补 5 项边界后重新跑全量 |
| `pnpm --dir controller typecheck` / `pnpm --dir controller build` | PASS |
| `node verify.mjs --suite integration` | 6 checks PASS：三组件构建、11 项 Compose 校验、真实临时 PG/HTTP/Go/合成 owner 整链、登录集成 |
| `git diff --check` | PASS |

独立协作者对产品差异单遍审查 `findings=[]`；主控另读实现、测试并运行上述全量及集成。首次旧测试仍断言 read command 与终端快照，出现 3 个预期契约冲突；已更新为新历史合同并保持明确诊断快照断言，没有放宽产品权限或省略验证。

新增独立回归覆盖：无读取能力、离线/未知/错目标，loaded=false；control/desktop/terminal 三种来源；未配置 terminal 禁止读屏；8 条和两层 JSON/Unicode 预算、巨大元数据、空页与原裁剪；异常正文不泄露；真实 NodeHub 15 秒超时/取消/迟到回复隔离；85 秒模型步骤后由同一 90 秒总信号取消历史；并发/持久重放零重复读；active 列表不读正文；无新增 command、commandIds、回执 commandId。

跨层新增测试复用已有合成桌面 owner 和真实 Go Daemon，不额外启动真实会话。通过 `/v1/messages` 触发模型工具，原历史最新 8 条顺序、正文裁剪、source/scope/completeHistory/hasOlder 通过。SQL 对比全库命令 ID 与聊天 commandIds 恒等；重复 messageId 后模型调用计数、工具结果计数、PG revision/data、owner starts/fullHistoryLoads 全部不变。模型桩只证明工具链路，不冒充真实模型理解。

终端集成明确验证无 historySource 时模型查询返回 `history_unavailable`、无 pane.read/新增命令；另通过显式管理 read 验证带裁剪提示的终端快照仍可用。原发送、技能组合、计划、结果接力、通知、登录测试继续通过。

临时集成进程与容器由统一入口收尾；结束后 `docker ps` 仅保留原两个本地容器，没有新验收容器遗留。

## 发布前检查

15:51:59 UTC 远端 PostgreSQL `REPEATABLE READ READ ONLY` 全量审计：21 条命令（19 completed / 2 failed），无未决命令；4 个聊天状态无 claim/pending，1 个 completed 计划，1 个 pending 通知尚未领取。五表摘要与上一轮部署完全一致。此处未用 `/v1/status` 的有限列表冒充全量。

两节点 Daemon 与 Codex App 无需更新；本轮只需替换远端 Controller/Web 镜像，Web 产物仍为 `index-DyMTH1BJ.js` / `index-BmkiR_3Q.css`。Gateway 通知仍关闭，保留 checkpoint、通知记录、PG、节点 token 和 journal。

此提交时尚未构建新镜像、部署或执行真实模型查询；后续操作须在本文件另记实测身份和结果，不以本地通过推断上线完成。

## 2026-10-13 正式发布增量

产品提交 `75049cb9f309665cd04bfeb34b226eded84097ba` 已推送。GitHub [38274057862](https://github.com/TaoSama/wechat-super-leader-bot/actions/runs/38274057862) 的 Ubuntu 全量（5m53s）和 macOS 单元套件（1m35s）均 success，核验 headSha 与产品提交一致。

使用干净 `git archive 75049cb` 在本机构建 linux/amd64 镜像，非 root `node`；镜像 ID 为 `sha256:d38a7cc05e338c93be2c66f671e943a3bfc837273b7ef4509c42a6a5c2b48ea7`，OCI revision 标签为短值 `75049cb`。本机与远端的 image ID、全部 10 层 RootFS 一致。无网络、只读根文件系统的短生命周期容器烟测通过 health、资源、鉴权、登录/Cookie、SSE、退出；正常 exit 0 并自动清理。镜像经 `docker save | gzip | ssh ... docker load` 流式上传，无镜像归档文件、无远端构建、无系统配置变更。

16:07:14 UTC 正常停止原 Gateway 和 Controller，均 exit 0、OOM=false；PG 保持运行。16:07:21 停后审计与发布前五表摘要完全一致，没有未决命令、claim 或待确认计划。仅以 `--no-deps --no-build --pull never --force-recreate controller` 替换 Controller，未删除 orphan Gateway。新容器 `80c844b2f992b0d2dd40edab743d55878104aed1da5f9f3fb49295e60011b891` 使用上述精确镜像，healthy、restarts=0；16:08:34 五表再审计完全一致。随后恢复原 Gateway，16:09:58 成功轮询、errors=0、通知开关仍 false；三服务 healthy。节点 A/节点 B 均 connected，没有更新两节点 Daemon 或重启 Codex App。

此次切换前后业务摘要：

| 表 | 行数 | 摘要 |
| --- | ---: | --- |
| commands | 21 | `3d751606f40ad9c773b01d9942d2b701` |
| messages | 32 | `c53c4a5772cc2318dac8a6fdf661a407` |
| leader_states | 4 | `2584be986dfbe98714b75af4a7321c85` |
| leader_executions | 1 | `50d9fd2580e6ee3999c0ec9803d8d52f` |
| leader_notifications | 1 | `8b418d890b46446adc71c839da339f0c` |

commands 摘要沿用运维审计公式，排除 `input_receipt` 列；真实模型验收脚本另使用包含全部列的整行摘要。不得混同比较这两种摘要。

### 真实模型验收的失败证据

复用专用会话 `c0863a5b-311c-5ab9-997b-be2e24fffb18`，不新建 Task、不发送任务。首次独立历史预查实际来源为 `control-socket`，最新助手文本 `HISTORY_FIX_OK_20261012`；本轮不能声称真实来源是 codex-desktop。来源选择是首次路由，不是失败后降级。

验收脚本只模拟服务器入站，不冒充真实手机微信；使用真实 `gpt-6.1-sol`。它额外以只读 SQL 检查近期上下文和记忆均未包含最后记录 id/原文，prompt 也不提供两者；要求回复原文、未知 id、实际来源、请求窗口内的 fetchedAt，并核对全库命令/计划/通知、commandIds/记忆摘要和重复 messageId 的状态恒等。独立审查指出原本只比固定文本不足以排除上下文回声，故增加上述交叉核对；仍不声称独立测量了正式工具调用次数。

- `leader_history_release_20261013_a`：HTTP 回复耗时 61009ms，明确超时，无 commandId；原文断言失败，未记作 PASS。日志参考 `6283a845b8bb`：`modelSteps=1, toolCalls=0, totalModelMs=60005, category=timeout`。16:12:07 全量审计显示 commands/executions/notifications 摘要不变，messages 32→33，聊天 revision 34→36，无 claim/pending。
- `leader_history_release_20261013_b`：只读重试 HTTP 回复耗时 31269ms，明确模型服务暂时不可用，无 commandId；原文断言再次失败。日志参考 `dd3088b4c3e5`：`modelSteps=1, toolCalls=0, totalModelMs=30382, category=transport, attempts=1`。16:14:40 全量审计确认 commands/executions/notifications 摘要仍不变，messages 33→34，聊天 revision 36→38，无 claim/pending。没有因未知执行状态重发会话任务。

验收同时发现 节点 A 心跳入库反复 `23505 / node_sessions_pkey`。同刻 `/v1/status` 19 条会话按节点/ID 无重复；该缓存表故障与模型首次调用超时是两个独立问题。交由独立协作者检查快照替换事务及重连顺序，修复前不宣称线上验收完整通过。

### 真实模型只读验收通过

`leader_history_release_20261013_c` 的第三次查询耗时 27238ms，原文与历史记录 id 均精确匹配，返回 `source=control-socket`、`fetchedAt=2026-10-12T16:16:14.664934Z`、`scope=recent_recorded_history`，并正确说明 8 条、`completeHistory=false`、`hasOlder=true`、`omittedItems=0`、`truncated=false`。最后助手记录 id 为 `msg_0bebcd83b33148fe016accfb1f95a487d0847a07f5267c4240`；事前 SQL 已证实它与原文均不在当前聊天历史/记忆中，验收 prompt 也未提供。

验收脚本完成并 exit 0：全库 commands 21→21 且完整行摘要恒等；executions、notifications、聊天 commandIds 和 memories 摘要恒等；messages 34→35；无 claim/pending，无返回 commandId。同 messageId 重放后响应及全部验收摘要完全相同。此前两次失败记录如实保留，没有删除状态或延长模型预算来掩盖故障。

这证明真实模型返回了原记录与本次时间、HTTP 持久去重且无新增持久派发；不等于对正式每次工具/owner 调用做了独立计数，也不证明真实微信手机入站、当前桌面 owner 控制或终端发送。已调用桌面归档接口重新归档复用验收会话，未删除其历史。

## 其他实机检查与仍未证明项

- 节点 A 当前为 macOS 设备。进程和 Unix socket 两通道未发现已有终端宿主；唯一既有 tmux pane 前台为 python3.11，无 Agent 子进程；无 TTY 且 stdio 指向 `/dev/null` 的后台 Codex 进程不能冒充 CLI pane。因此未开启终端参数、不生成虚假 terminal ID、不启动替代 worker。
- 节点 B SSH 正常，原只读 Daemon PID90884 / f6b2b5d、App PID1304、IPC 0600 均保持；控制 socket 仍缺失。精确目标持久元数据未更新，没有新 owner 证据，本轮未重复以前已完整超时的 discovery；当前瞬时 owner 未重新证明，不能宣称当前无 owner 或已可控。
- 公司 devbox/devsg 在本机已配置 SSH Include 中没有对应入口；macpro 直连超时，devos 经该跳板 banner exchange 超时。没有猜测地址、改通道或上传公司数据。
- 真实微信手机入站/内置浏览器、节点 B owner 控制、公司机器、Linux 用户服务、真实 CLI 精确完成、动态自治/重规划和长期负载仍须独立证据。

回退本次查询接线可以使用支持现有技能/计划结果数据合同的上一镜像；不能降级到拒绝这些持久字段的更老 Controller，不删除数据库或 journal 绕过任何不确定状态。
