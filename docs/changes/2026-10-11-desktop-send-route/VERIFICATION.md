# 原桌面发送资格与固定路由

日期：2026-10-11。范围：本地 Daemon → Controller/Leader → Web 接线及自动验收。尚未更新香港运行服务或已安装的宿主 Daemon；未改变 App transport、重启桌面应用、创建真实测试会话或外发微信。

前阶段已通过专用原桌面会话真实发送并归档，证据在 [原 owner 验收](../2026-10-11-desktop-owner-send/VERIFICATION.md)。本阶段不重复该实发，而用模拟桌面端验证新接线，避免把不同层次的证据混在一起。

## 实现

- Daemon：`--desktop-send` 默认 false，要求显式 `--desktop-sock`；独立完整只读预检，不建 command claim、不发 turn。最多两个检查同时运行，每目标完成后至少 30 秒再查，资格 TTL 45 秒。初次未检查是 epoch ISO / 零有效期。慢目标不阻塞心跳或原生发现，取消时等待自身 worker 退出。
- owner/revision 作为内部 generation 证明，不出现在 JSON；迟到检查不能跨 owner/revision、断连或移除再加入恢复 ready。失联、busy、unknown、过期立即撤资格且不伪造新检查时间。native 的 loaded/status/capabilities/observedAt 保持原事实。
- 只有已证明精确桌面 owner 才首次建立桌面资格；native-only 会话不受全局开关误禁。已存在的资格撤销后仍保留字段，禁止变成 native fallback。仅真正移除目标才清理其记录。
- Controller 共用 `selectSendRoute`：桌面字段存在则必须合法 ready、`observedAt <= now < validUntil` 且有效区间不超过 45 秒；桌面观测如存在，须可用、新鲜、idle。完全没有桌面字段时，native 路线须 loaded=true、idle、send、非未来且不超过 45 秒的 ISO 观测。
- 新命令只选择一次 route，写入 Memory/PG/WS；PG 仅新增 nullable `send_route` 列，历史空 route 不补选或重派。重复 requestId 返回原命令，不重新选择。持久化后、实际发送前再次检查同路线；变化则保存 failed、零派发。
- Leader 模型不能提供 route；提计划由服务端绑定，确认与派发再次验证，旧未绑定计划要求重新生成。状态工具向模型解释独立资格，不把 loaded=false 一概解释成无法向原桌面发送。
- Web 显示通道、阻塞原因及回执固定路线。非法但 present 的资格/桌面观测保留为拒绝，不被 normalization 删除后绕过。资格在无下一次心跳时也自动到期；点击、Enter、未知请求恢复均按当前时间复验。已知 command 的只读回执查询不受发送资格过期影响。

## 验证命令与证据

由主任务独立运行，而非仅采用协作任务报告：

| 命令 | 结果 |
| --- | --- |
| `pnpm --dir web test` | 10 文件、144 测试通过；新增 44 个资格/点击/回执用例 |
| `pnpm --dir web run typecheck` | 退出 0 |
| `pnpm --dir web run build` | 退出 0 |
| `pnpm --dir controller test` | 29 文件、310 测试通过 |
| `pnpm --dir controller run typecheck` | 退出 0 |
| `pnpm --dir controller run build` | 退出 0；包含最新 Leader 资格说明 |
| `go test -race ./... -count=1`（daemon） | native-only 修正后 8 个有测试包全部通过；client 21.863s、codex 10.907s |
| `go vet ./...`（daemon） | 退出 0 |
| `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build ./...`（daemon） | 退出 0 |
| `pnpm --dir gateway test` | 35 测试通过，无微信网络操作 |
| `node test-integration.mjs` | 最终代码复跑退出 0；真实临时 PG、真 Go Daemon、模拟桌面 IPC 全链路通过 |
| `node --test local.test.mjs test-live-session.test.mjs test-wechat-model.test.mjs` | 19 测试通过，无真实会话发送 |
| `git diff --check` / 新增 Go 文件 `gofmt -l` | 退出 0 / 无输出；untracked 源码另外由构建和全量测试验证 |

集成新增 `test-desktop-route.mjs`，由既有 runner 调用：只启动测试自己的 Controller、PostgreSQL 容器、模拟 socket 和真 Go 二进制。使用新建临时 rollout/journal，控制 socket 指向确定不存在的临时路径，因此不能意外走本机真实 Codex；不读取模型或微信凭证。

关键断言：

1. 文件发现目标保留 `loaded=false,status=unknown,capabilities=[read]`，独立桌面资格 ready，预检的 turn-start 次数为 0。
2. 精确会话 HTTP 请求 → PG 固定 desktop-owner → WS → 真 Go → 精确 owner/session/clientUserMessageId；继承原设置，一次发送。
3. accepted 后通过精确原生 turn 查询得到 `fixture-native-turn` / completed / `EXACT_DESKTOP_FIXTURE_OUTPUT`。
4. 模拟 owner 变忙立即撤资格；新请求 409、零额外 turn-start。旧 requestId 仍返回原记录和路线，不二发。
5. Controller 重启后原 command/route/turn/output 全部保持；两个独立 PG client 验证两条路线 SQL 往返，重复创建不能改 route，历史 null 保留。
6. 既有节点隔离、同会话 ID 跨节点路由、伪造回执拒绝、模型计划/确认、技能版本、聊天记忆和重启回查仍通过。

测试 runner 在 finally 中正常关闭自身子进程、socket、容器并清理自身临时目录。原 PostgreSQL 容器与其他应用保持运行；真实 fixture journal `.runtime/desktop-owner-acceptance/` 未改动。

## 发现与修正

- 首轮集成断言误把纯文件发现的原状态写为 notLoaded，实际按既有契约是 unknown。按源码核对后修正测试为精确 unknown，不修改生产元数据语义；第二轮全链路通过。
- 交叉检查发现 DesktopSend 开关初版在还没找到 owner 时为所有 ID 写 unavailable，会误禁原本可发的 native-only 会话。新增对照测试先复现红灯，再将首次资格建立限制为已有精确 owner 证明；已有记录撤销仍不允许 fallback。
- 旧前端发送 fixture 使用过期的硬编码观测时间。测试固定时钟到该观测时间，保留生产新鲜度门禁，没有放松规则来迁就测试。

## 仍未证明与回退

原 owner IPC 为私有协议。ready 是近期预检结果，不是原子租约；snapshot 没有 nonce，实际两次预检也不能消除与 App 用户同时输入的竞争。不能宣称保证不干扰。

本轮没有新的原桌面实发、生产部署、真实微信入站或手机内置浏览器验收，也不证明 Mini、公司机器、独立 CLI/Claude/Grok 的原进程附着能力。页面 UI 已通过 DOM 交互测试，本轮未新增像素截图验证。

没有线上变更需要回滚。未来停用新发送只撤 `--desktop-send`，保留 journal、固定路线、turn ID 和只读查询。现有持久状态不能因故障而清空；不创建备份，不恢复旧 Python 架构。
