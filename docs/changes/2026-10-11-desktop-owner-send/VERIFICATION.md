# 原桌面 owner 发送验证

日期：2026-10-11。范围：宿主 Daemon 适配器与持久 journal；未部署、未更改 App transport、未另起 app-server、未修改 Codex 数据库。

## 结果

复用专用验收会话 `c0863a5b-311c-5ab9-997b-be2e24fffb18`，项目目录仍为 `/Users/developer/Workspaces/wechat-super-leader-bot`。使用宿主工具明确恢复并准备 fixture 后，Daemon 向既有桌面 owner 发送一次无工具、无文件修改的标记请求。

| 证据 | 实际结果 |
| --- | --- |
| 准备 turn | `9d2747b1-4636-57a7-9b60-54b0123acf44`，completed |
| 模型 | `gpt-6.1-sol`，low，沿用原会话设置 |
| 持久 command ID | `desktop-owner-20261011-01` |
| 原生受理 turn ID | `3892d689-af36-54de-9e77-270c4d7c6688` |
| Daemon 精确 turn 查询 | completed，正文 `DESKTOP_OWNER_VERIFIED_desktop-owner-20261011-01` |
| 独立宿主 `read_thread` | 同一 turn、同一正文、completed，duration 14607 ms |
| 同进程重复及 ACK 后重新打开 journal | 保持原 turn ID，不二次发送 |
| 清理 | 确认上述精确 turn 完成后归档 fixture；无新增测试会话 |

首次测试 harness 将 ACK 后结果与 ACK 前完整结构比较，因此失败。核查 journal 的既有语义后，确认 ACK 有意清空 output/error、保留 turn/status/dispatch；修正断言为核对回执身份，然后使用相同 command/expiry/journal 重新执行。第二次直接回放既有受理回执并只读核查原 turn，未发送第二条请求。未删除或重建 journal。

## 持久派发边界

- `protocol.DispatchIdentity` 保存 route/session/clientUserMessageId/requestId/owner/connection/endpoint。
- `journal.Begin` 原子保存 claim 与 UUID；`BindDispatch` 在 native 写入前同步绑定不可变身份。
- `PrepareSend` 和 `Dispatch` 使用同一连接与 owner；不会启动、resume、重连后改投或回退另一适配器。
- 普通 resumed/default 用户线程（显式 user 或客户端明确定义的 null 默认）才可能发送。忙碌、审批、未确认提交、未知类型、错误目标和坏状态拒绝。
- 写尝试后超时、断连、错误 owner 或缺合法 native turn ID 一律 uncertain。原请求不重放。
- `ReadDispatch` 只路由精确 command/session/turn；已存在的桌面身份损坏、不匹配或未绑定时不回退控制 socket。
- 原 journal scope、已有 records 和 replay guard 保留。保存原路由不是新增旧架构兼容层。
- 执行 context 截止时间取命令 expiresAt、30 秒执行预算、父 context 三者最早值，覆盖 Dispatch 内的第二次预检与最终写入，而非只在预检前判断过期。

## 自动测试与复现

常规测试默认跳过真实发送；只在明确指定 fixture、持久状态目录、command 和过期时间时启用。以下为本轮实际命令，不能把新 ID 当作重试办法；原 fixture 现已归档，后续复验需先明确准备它。

```sh
cd /Users/developer/Workspaces/wechat-super-leader-bot/daemon
LIVE_DESKTOP_SEND=fixture-only \
LIVE_DESKTOP_SESSION=c0863a5b-311c-5ab9-997b-be2e24fffb18 \
LIVE_DESKTOP_COMMAND_ID=desktop-owner-20261011-01 \
LIVE_DESKTOP_EXPIRES_AT=2026-10-11T15:30:00Z \
LIVE_DESKTOP_STATE_DIR=/Users/developer/Workspaces/wechat-super-leader-bot/.runtime/desktop-owner-acceptance \
LIVE_DESKTOP_SOCKET=/Users/developer/.codex/ipc/ipc.sock \
go test ./pkg/client -run '^TestLiveDesktopOwnerSend$' -count=1 -v
```

结果：PASS，exact desktop turn completed；进程退出 0。`.runtime/desktop-owner-acceptance/commands.db` 为必要的去重证据，权限由 journal 限制为私有，未清理或复制它；不含请求正文，ACK 已清除回执正文。

自动用例覆盖：固定 owner/会话/连接、busy/approval/aeon、null 与缺失 source、canonical turn 与文本、坏帧/坏回执、取消/断连、单次写、不可变身份、ACK/重启去重与错误路由不 fallback。测试使用临时 fixture，不修改真实服务。

新增期限回归使用真实 DesktopController 与临时 Unix socket：第二次预检延迟至 expiresAt 之后。旧 WithTimeout 实现可复现 accepted、desktop writes=1；改为共享命令 deadline 后为零 desktop 写入、零其他路由发送，持久记录和重启 replay guard 保持。三轮 targeted race 通过，证明此次修复触及实际失效路径，而非只增加断言。

最终由主任务独立运行（包含期限修复后的全部落盘代码）：

| 命令 | 结果 |
| --- | --- |
| `go test -race ./... -count=1` | 8 个有测试包全部 PASS；client 21.700s，codex 12.039s |
| `go vet ./...` | 退出 0 |
| `go build ./...` | 本机构建退出 0 |
| `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build ./...` | Linux 构建退出 0 |
| 变更 Go 文件 `gofmt -l` | 无输出 |
| `git diff --check` | 退出 0；未跟踪文件另外通过编译、测试和格式检查核验 |

本轮没有修改 Controller/Web 代码，因此没有将既往的前端测试计为本轮的新路由端到端验证。

## 尚未证明与后续边界

1. 此阶段验证仅涵盖 Daemon 适配器；后续 Controller、Leader 和 Web 接线已完成本地源码与 fixture 验证，详见 [跨层路由验证](../2026-10-11-desktop-send-route/VERIFICATION.md)。运行服务仍未因此更新，不能外推线上能力。
2. 后续接线使用独立 `sendAvailability`，不将 `DesktopObservation.idle` 改写为 native loaded/send。资格来自完整只读检查并带显式有效期；新命令固定路由、持久化后不重选，Leader 确认与 Web 使用相同边界。
3. 当前 owner IPC 为私有协议。两次预检不是原子 compare-and-start；snapshot 广播无请求 nonce，在途旧 snapshot 可能满足读取，不能保证与 App 人工输入的并发无干扰。
4. 本轮仅证明本机已加载的专用 fixture；没有证明 demomini 注册、所有桌面会话、独立 CLI、Claude/Grok 或微信全链路。
5. 退出/卸载桌面 owner、丢失合法回执或无法查询精确 turn 时保持未知，不按相同文本或最新 turn 猜测完成。

回退：尚未部署，无线上回滚操作。若后续停用此路由，只停止产生新的 desktop-owner 命令，保留原 journal 和已派发 turn 的只读核查；不要清空状态来解除 uncertain。
