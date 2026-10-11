# 测试计划

## 自动化

在项目根目录执行：

```sh
node verify.mjs
node verify.mjs --suite unit
node verify.mjs --suite integration
node verify.mjs --list
```

完整入口先构建必要组件，运行 Go race/vet/本机与 Linux 交叉构建、Compose 配置检查、真实临时 PG 整链，再显式执行 `test-console-auth.mjs --run`。单独执行该登录脚本而不带 `--run` 只输出帮助，不算验收。统一入口禁用 dotenv、隔离业务环境变量与 live 开关，并只允许本地 Docker Unix socket；直接调用底层脚本不自动获得全部入口保护。

集成脚本只管理自己创建的临时 PostgreSQL 容器，使用模拟模型、节点，以及连接模拟桌面 socket 的真实 Go Daemon。不能把它算作真实模型/微信/物理跨机验收。清理失败仍尝试其他资源并返回失败，不将资源回收异常掩盖为通过。

`test-integration.mjs` 还调用 `test-node-isolation.mjs`，以独立 token 注册两个模拟节点，验证同名同 ID 会话定向派发、冒用节点身份拒绝、跨节点伪造回执拒绝、单节点断线不影响另一节点，以及重连只读恢复不重发。底层 HTTP/WebSocket 与 PostgreSQL 为真实组件，物理跨机网络与 TLS 不在该测试范围内。

## 真模型、真会话、模拟微信

用户已授权新建专用会话，模型使用当前 Codex provider 的 API 地址和 `gpt-6.1-sol`。禁止使用其他工作会话作为测试目标。

```sh
node test-live-session.mjs --help
node test-wechat-model.mjs --help
node test-live-skill.mjs --help
```

须证明：计划确认前没有 send；确认后取得 commandId 和 turnId；精确轮次 completed 且输出包含本次随机 marker；重复消息/请求不再次派发。微信网络只能使用注入的模拟实现，真实 Controller 和模型不可替换为桩后冒充全链路通过。

`node test-live-skill.mjs --run` 显式创建一个新的专用 Codex 会话（gpt-6.1-sol），通过 Controller/Daemon 绑定已安装 `ai-scaffold-init` 的 digest，只读核对 Skill 与四个项目符号链接。检查精确 turn、成功工具执行记录及 SHA256 输出，不触发微信。不要用它重试结果未明的任务；每次运行会创建新会话，结束关闭连接但保留会话历史。

## 人工微信验收

按 [运行手册](runbook/index.md) 配好发送者允许名单，由用户亲自发自然语言消息并核对原会话和微信回复。无需 slash 命令。

## 仍需单独验收

物理跨机 TLS/重连/双节点隔离、Claude/Grok 的原会话控制、技能实际执行、持续自治依赖调度、长时间运行和压力测试。测试进程完成不等于业务任务成功，服务健康不等于模型或微信健康。
