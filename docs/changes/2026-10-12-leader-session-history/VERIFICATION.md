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

## 其他实机检查与仍未证明项

- 节点 A 当前为 macOS 设备。进程和 Unix socket 两通道未发现已有终端宿主；唯一既有 tmux pane 前台为 python3.11，无 Agent 子进程；无 TTY 且 stdio 指向 `/dev/null` 的后台 Codex 进程不能冒充 CLI pane。因此未开启终端参数、不生成虚假 terminal ID、不启动替代 worker。
- 节点 B SSH 正常，原只读 Daemon PID90884 / f6b2b5d、App PID1304、IPC 0600 均保持；控制 socket 仍缺失。精确目标持久元数据未更新，没有新 owner 证据，本轮未重复以前已完整超时的 discovery；当前瞬时 owner 未重新证明，不能宣称当前无 owner 或已可控。
- 公司 devbox/devsg 在本机已配置 SSH Include 中没有对应入口；macpro 直连超时，devos 经该跳板 banner exchange 超时。没有猜测地址、改通道或上传公司数据。
- 真实微信手机入站/内置浏览器、节点 B owner 控制、公司机器、Linux 用户服务、真实 CLI 精确完成、动态自治/重规划和长期负载仍须独立证据。

回退本次查询接线可以使用支持现有技能/计划结果数据合同的上一镜像；不能降级到拒绝这些持久字段的更老 Controller，不删除数据库或 journal 绕过任何不确定状态。
