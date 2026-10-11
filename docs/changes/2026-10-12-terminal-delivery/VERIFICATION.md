# 原终端输入投递验证

2026-10-12，本机开发验证。基线 `8b3baeb`，此次范围为其上的投递模块、独立回归、公开包示例和验证入口；不是已有累计提交的重新验收。未部署、未操作真实会话、未修改 App transport 或系统配置。完整 Super Leader 目标保持未完成。

## 新增内容

- `daemon/pkg/terminal/delivery.go`：显式已发现目标的只读准备、完整身份和文本摘要冻结、一次性 Dispatch、同目标前后复核、结构化脱敏错误及幂等 Close。
- Observer 的只读方法白名单不变。私有传输共用 framing/严格 JSON/截止逻辑，不暴露通用可写 RPC 方法。
- 回执仅 `terminal-input-written`，不含任务输出、turnId 或完成状态。相同准备对象不重复投递；新对象和进程重启的持久防重发尚未接入。
- `daemon/examples/terminal-delivery/` 提供可重放的公开包运行示例；标准 flag 解析，默认帮助，只接受 `--run`，不接受外部 socket、会话或 prompt。
- `verify.mjs` 的 unit/all 计划增加公开包示例运行；unit 现有 13 项检查。

## 运行观察：公开包边界

命令在 `daemon/` 运行：

```sh
go run -race ./examples/terminal-delivery --run
go run ./examples/terminal-delivery -h
go run ./examples/terminal-delivery --socket /nonexistent
```

示例自行创建临时 Unix socket，用真实 JSON RPC 驱动公开 `Observer`、`DeliveryController`、`PreparedDelivery` 接口。不是读取源码后直接调用内部函数，也不是微信到真实 CLI 的生产验收。

最终 `--run` exit 0；四个场景输出：

```json
{"scenario":"delivered","promptWrites":1,"receiptKind":"terminal-input-written","uncertain":false,"repeatRejected":true,"completionProven":false}
{"scenario":"binding-changed","promptWrites":0,"uncertain":false,"repeatRejected":true,"completionProven":false}
{"scenario":"acknowledgement-lost","promptWrites":1,"uncertain":true,"repeatRejected":true,"completionProven":false}
{"scenario":"blank-prompt","promptWrites":0,"uncertain":false,"repeatRejected":false,"completionProven":false}
```

`promptWrites` 是合成宿主收到的完整 prompt RPC 数，不是实机 PTY 接收或模型执行次数。空白场景在准备阶段即拒绝，未进行重复 Dispatch，故其 `repeatRejected=false`。

### 发现与修正

- 新增空白输入运行反例时，第一次 exit 1：`blank-prompt: blank prompt unexpectedly prepared`。根因为校验只拒绝空字符串。改用 `TrimSpace` 判断是否存在非空白字符，但投递仍保留原始文本与摘要，没有 trim 或归一化用户输入；增加中文、组合字符、全角空格和长度边界测试。上述四场景再次 exit 0。
- 准备后将同 pane 的 session 替换：零 prompt，不能把旧目标身份带入新会话。
- 宿主收取输入后断开、未回响应：只有一次 prompt，结果 uncertain，重复调用拒绝。
- `-h` exit 0，显示合成边界；`--socket /nonexistent` exit 1，明确未定义该参数，没有连接用户指定位置的能力。
- 示例返回 `completionProven=false`，即使投递成功也不宣称 Agent 完成。

## 代码测试与回归

以下是测试/构建证据，与上面的公开接口运行观察分开记录：

| 命令 | 结果 |
| --- | --- |
| `node --test verify.test.mjs` | 8/8 PASS，校验新增步骤及原环境隔离、失败收尾规则 |
| `go test -race ./pkg/terminal -run '^TestDeliveryRegression' -count=20 -timeout=90s` | 独立评审运行，PASS，4.681s |
| `go test -race ./pkg/terminal -run '^TestDelivery' -count=20 -timeout=90s` | 实现单元运行，PASS，6.768s |
| `node verify.mjs --suite unit` | 主控运行，PASS 13 checks / exit 0；含全包 race/vet、公开包示例、macOS/Linux 构建；terminal race 5.287s，codex race 30.405s |
| `node verify.mjs --suite integration` | 主控运行，PASS 6 checks / exit 0；含组件构建、Compose 配置、真实临时 PostgreSQL 整链和一次性登录验证 |

回归覆盖：准备零输入、严格身份/UUID/UTF-8/长度/控制字符、明确就绪字段、目标和 revision 变化、20 路并发 Dispatch/Close、过期与阻塞读取取消、零字节或半帧 Write 后失败、丢/坏/错目标回执、关闭失败、输出脱敏及原只读白名单。源码和独立测试评审无未解决阻断项。

整链验证的是原有产品链路回归：真实 Go 终端观测经 Controller/PostgreSQL 仍只读；原桌面 owner 的精确发送、历史分页、回执恢复与防重发规则保持通过；持久计划、通知及一次性登录也通过。模型、微信、桌面 owner 和终端宿主均为合成目标，不能据此宣称新投递器已完成生产 CLI 端到端验收。最终输出：

```text
[verify] PASS 6 checks (integration); synthetic fixtures only, no production acceptance claimed.
```

一次性登录测试日志确认自有容器 `super-leader-console-test-4503cf57-67dc-5b30-983e-ae5fb433b377` 清理成功；运行器正常 exit 0，未人工中止或重跑仍在执行的检查。

## 交付边界与后续

生产 `client/config/protocol/Controller/Web/Gateway` 没有接入发送入口；构造器的非测试调用只有合成示例。原终端命令仍被正式路由拒绝，不能用这个模块绕过 journal。没有声明本条 CLI 任务开始或完成，没有自动解锁依赖。

后续必须完成：派发前持久 claim 与完整身份绑定、重启和 ACK 去重、Controller/微信/Web 的精确路由、提供方任务关联与完成证据、明确 pane 的真实验收。同 PTY 内 foreground/session 非原子窗口仍未封闭，metadata 自报也不是原生完成回执；启用策略不能默默降级现有合同。

没有修改技能或全局规则，运行配方保存于本文件。测试和示例自行关闭连接并回收自建临时目录；主控核查 `/tmp` 中 `terminal-delivery-sample-*` 和 `terminal-delivery-regression-*` 均为 0。未创建验收会话、备份或生产进程。此次不改变运行中的二进制/数据库合同，回退只需撤销源代码变更，无需数据迁移。
