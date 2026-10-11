# 验证与交付记录

日期：2026-10-12。主任务在 `/Users/luwentao/Workspaces/wechat-super-leader-bot` 独立执行；未部署、未发送真实微信或会话消息。

## 当前结果

```text
node verify.mjs
[verify] PASS 15 checks (all); synthetic fixtures only, no production acceptance claimed.
exit 0
```

主任务实际完成以下验证，不将此前轮次的测试数累加：

| 范围 | 本轮结果 |
| --- | --- |
| Controller 类型、全部单测、构建 | 统一入口全部通过 |
| Gateway 全部单测、构建 | 统一入口全部通过 |
| Web 全部单测、构建 | 统一入口全部通过 |
| CLI、runner、Compose helper、dotenv 与 cleanup 根测试 | 74/74 通过 |
| `go test -race -count=1 ./...` | 全包通过；client 22.578s、codex 27.706s |
| Go vet、本机构建、`CGO_ENABLED=0` Linux amd64 构建 | 全部退出 0 |
| Compose 配置与环境隔离 | 9/9 通过 |
| 真实临时 PG / HTTP / WS / Go Daemon 整链 | 通过，模型/桌面/微信均为模拟目标 |
| `test-console-auth.mjs --run` | 8 阶段全部通过，临时 PG 容器正常清理 |
| `actionlint .github/workflows/verify.yml` | 退出 0，无诊断；不是远端 CI 结果 |
| `git diff --check` | 退出 0；新增源码另由编译、语法与格式检查验证 |

登录专项真实执行了 hash-only 持久化、两客户端并发与事务回滚、1 小时链接/登录过期、8 个并发兑换唯一成功、Cookie/Bearer 权限、重启后已兑换状态保留以及退出撤销。不是只执行帮助信息。

整链仍证明固定依赖计划、聊天隔离、技能版本绑定、重启只读恢复、精确 turn 终态、取消后不启动后继，以及终态通知默认关闭/领取后结果未知不重发；不证明真实微信送达或所有远端宿主可控。

## 新回归与失败证据

- 原 WebSocket cleanup 对 CLOSED 对象再次等待 close，会永久等待。新增 helper 的 CLOSED、同步 close、异步 close、error、超时与后续清理回归 11/11 通过。
- 原环境白名单不能阻止 dotenv/Vite/Compose 读取磁盘 `.env`。合成文件测试现证明禁用后不导入文件变量，认证与数据库/模型缺项仍报错。Web 回归监控真实 Vite 文件读取次数为 0；普通加载对照为 4。
- Web 回归首次使用 `resolveConfig(..., 'build')` 却未显式设置 production mode，实际只加载 2 个通用文件，断言 4 失败。查 Vite loader 后将合成对照明确设为 production；不是放宽零读取断言。修正后 `node --test verify.test.mjs scripts/verification-env.test.mjs scripts/test-cleanup.test.mjs` 20/20 通过。
- Compose 插件与独立发行选择发生在只读 version 检测；操作一旦开始，失败直接传播，不切换实现重放操作。

## 环境与边界

本机 Node `v26.3.1`、pnpm `11.8.0`、Go `go1.26.4 darwin/arm64`。Docker endpoint 为本地 Colima Unix socket。工作流固定 Node 24，但尚未在 GitHub 执行，不能宣称 Node 24 / Ubuntu / macOS CI 矩阵已绿。

完整验证后执行 `docker ps -a --filter name=super-leader-test- --filter name=super-leader-console-test- --format '{{.Names}} {{.Status}}'`，无输出。正式 `.runtime`、用户会话、token、journal、微信 checkpoint 与生产 PostgreSQL 未清理或复制。没有创建备份。

原架构迁移源码与本轮入口在验证时仍有未跟踪文件；随后按显式路径一并纳入本地源码提交，包含四组件、锁文件、验证入口、CI、文档与旧 Python 删除。未推送、未创建 PR，也没有远端 CI 结果；本地提交不等于 GitHub 已交付。停止本地验证不改变运行服务；关闭验证专用 dotenv 开关只恢复正常配置文件读取，无需操作数据库或会话。

提交范围检查只读核对了候选文件、Docker/CI 引用和忽略规则；有限的私钥、API token 与长 Bearer 模式扫描无命中，URL 测试中的凭据值已确认是合成常量。10 张 PNG 已逐张查看，均为合成工作台验收画面，未见登录凭据；这些检查不构成全面安全审计。首次暂存检查发现 11 个文件多余的末尾空行，移除后以 `git diff --ignore-blank-lines --exit-code` 确认不改变代码内容。主架构、文档导航与陷阱页也同步移除旧 Python 队列描述，区分原 owner 接入、固定依赖调度和未完成的真实验收。

完整项目仍未完成：Mini/公司机器及其他 CLI 原宿主接入、动态自治、实际微信入站验收与新版部署分别需要自己的证据，不能被本记录替代。
