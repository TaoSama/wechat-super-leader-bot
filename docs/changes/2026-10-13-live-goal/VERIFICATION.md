# 原会话持续目标真实验收

2026-10-13（Asia/Shanghai）。产品为香港 Controller/Web `08e260a`、Air Daemon `08e260a`；本轮只新增只读诊断测试及文档，没有部署新产品。先前资格失败保留在 [首次记录](../2026-10-13-continuous-goals/VERIFICATION.md)。

## 结论与边界

Air 的既有专用桌面会话真实完成一次确认后的两轮结果驱动任务。Controller 持久记录、正式 HTTP 与原 owner 精确 turn 查询一致。两条入站均由服务端模拟微信：不是手机发送，不证明真实微信目标控制、跨物理机接力、CLI 精确完成或长期稳定性。没有新建后端、resume、claim writer、修改 App transport 或向其他工作会话输入。

复用会话 `01a12a91-5777-75e0-8df3-4ee968565997`，完成后重新归档并返回主线程。模型 `gpt-6.1-sol`，冻结目标只有 macair 的该会话 / desktop-owner；skills=[]，纯文本、不工具、不文件、不联网、不改设置。预算为 2 次动作、4 次判断、10 分钟；明确允许共享第一轮结果。

## 资格诊断

正常取消归档、精确导航后，同一会话先 unavailable，随后 ready。只读历史诊断 0.22s PASS；新增分阶段只读 readiness 诊断约 21ms PASS：ordinary/resumed/default，runtime idle，零 requests/unconfirmed/nonterminal，11 个已结束 turn。所有连接关闭，零派发。

第一次确认前检查资格不满足，验证器 exit 1，没有提交确认。随后只等待同一资格：19:33:59 unavailable → 19:34:02 checking → 19:34:06 ready；19:34:06.897 UTC 正式确认。没有修改产品资格判定。

源码可确认 owner/revision 变化会作废在途 probe，完成（包括作废）后延后 30s 检查，observer 30s 换轮短暂失效；settings/history 拒绝与传输超时分类不同。但缺少旧失败的阶段日志，不能声称这些机制就是当时根因，也不能用当前成功抹去旧失败。

## 精确执行证据

目标：`9d208fd2-2c04-4871-b7c0-d37ee3248610`。

| 动作 | commandId | 原 owner turnId | 精确输出 |
| --- | --- | --- | --- |
| 1 | `cmd_bc0734ab-965d-4c1a-b906-435548dc08f9` | `01a1319b-cd96-7121-b6f9-35451b75c49c` | SUN |
| 2 | `cmd_2c8052ec-a90b-4561-b4ee-8ef9050efe84` | `01a1319c-1bb9-76a2-bf7b-131bf46c541b` | DAY |

第一轮完成 19:34:21.794 UTC，第二轮创建 19:34:36.761、完成 19:34:41.235。第二轮明确 sourceActions=[1]；SUN/MOON 分支是在第一轮完成后根据实际结果决定，不是预先提交第二条固定 prompt。最终 revision=9、actions=2、decisionAttempts=3、无 lease，决策为 next→next→complete。两条条件分别引用动作 [1]、[1,2]，supported=true。

输出 SHA256：SUN=`d44fa953853bae3a2ab71f5d5236ede3b67f31aeff84aa56235be191d78f7eb5`；DAY=`c45bc4a7dc2c7ac5b8ecc864507a90b6cb579d280b6c1eaf5db524c5e265baf7`。

三条独立验证路径：

1. 正式 `/v1/status` 两动作 completed、条件 supported。
2. PG 冻结目标与准确 `/v1/commands/:id`：确定性 requestId、每请求一条命令、目标/路线/实际输入完全相等；第二步来源 command/turn/excerpt/hash 等于第一步完成结果；第二决策证据对应第一步，最终证据对应两步；第二步创建不早于第一步完成。只有 `goal_owner_live_20261013_preview` 和 `goal_owner_live_20261013_confirm` 两条模拟入站，pendingGoal 已清。验证器输出 `durable-dynamic-goal-PASS`。
3. 独立 Go `DesktopController.InspectTurn` 读取原 owner 两个 exact turn，均 completed，结果映射及 SHA256 相同；输出 `original-owner-exact-turns-PASS`，sends=0。临时验证器首次编译的 typed status/string 比较错误已修正，不涉及产品代码。

模型曾把“当前只生成预览”这类阶段措辞写入冻结 constraints，后续理由带有预览字样；确认、动态执行和完成判断实际通过。没有在确认后篡改既有授权。后续应改善预览工具提示区分流程说明与持久限制；本轮未实现此项。

## 诊断测试与命令

在 `daemon/` 执行：

```sh
LIVE_CODEX_DESKTOP_SOCKET=/Users/luwentao/.codex/ipc/ipc.sock \
LIVE_CODEX_DESKTOP_SESSION=01a12a91-5777-75e0-8df3-4ee968565997 \
LIVE_CODEX_DESKTOP_HISTORY_DIAGNOSTIC=1 \
go test ./pkg/codex -run '^TestLiveCodexDesktopReadonlyHistoryDiagnostic$' -count=1 -v

LIVE_CODEX_DESKTOP_SOCKET=/Users/luwentao/.codex/ipc/ipc.sock \
LIVE_CODEX_DESKTOP_SESSION=01a12a91-5777-75e0-8df3-4ee968565997 \
LIVE_CODEX_DESKTOP_READINESS_DIAGNOSTIC=1 \
LIVE_CODEX_DESKTOP_READINESS_EXPECTED=ready \
go test ./pkg/codex -run '^TestLiveCodexDesktopReadonlyReadinessDiagnostic$' -count=1 -v -timeout=20s

go test ./pkg/codex -run 'TestDesktopReadonlyReadinessDiagnosticFixtures|TestDesktopReadiness' -count=1
go test -race ./pkg/codex -run 'TestDesktopReadonlyReadinessDiagnosticFixtures|TestDesktopReadiness' -count=1
go test ./...
go vet ./...
```

全部 PASS。真实诊断仅在本次专用会话正常打开时执行；会话已归档，不应未经恢复再跑并把无 owner 误报为回归。新增测试 8s 总时限、严格 opt-in、显式 ready|busy，输出固定分类/布尔/计数/耗时，不输出正文/owner/path/raw error；合成 fixture 要求最终 EOF，多余写入失败。独立评审未发现阻断问题。

## 最后审计

2026-10-12 19:38:37.899752 UTC，执行 [audit.sql](../2026-10-13-continuous-goals/audit.sql)：23 commands（21 completed / 2 failed），无未决命令，4 个聊天均无 claim/pending/pendingGoal；一个既有 completed 固定计划不变；新增目标 completed 且无 lease。

| 表 | 行数 | MD5 |
| --- | ---: | --- |
| commands（排除 input_receipt） | 23 | `047fa888921060e187a261e4af5b856b` |
| messages | 39 | `8f80768801a65edfd281c1babde6c073` |
| leader_states | 4 | `892b0d2918f79df58cdf96a9939c5339` |
| leader_executions | 1 | `50d9fd2580e6ee3999c0ec9803d8d52f` |
| leader_notifications | 1 | `c6d5deec003490f2d6dc72b4ac634bbf` |
| leader_goals | 1 | `bdf2d9b607f5523de6aa09dd5e32a1f2` |

唯一旧通知 `2911e3f7-b9ad-4cbe-9c62-5c2593bd512c` 仍为 uncertain，attempt=`241d61ae-1aa1-4070-bbd9-112d14af0b47` 不变；没有补发或清记录。持续目标此时没有主动通知实现，不凭目标完成宣称手机收到通知。

公司机器只读重查：devbox/devsg hostname 无法解析，devos banner exchange 超时。本机没有现成受控 CLI pane；未安装程序、修改系统别名或代理。需真实入口/组织数据边界，不能以 Air 验收替代跨机证明。
