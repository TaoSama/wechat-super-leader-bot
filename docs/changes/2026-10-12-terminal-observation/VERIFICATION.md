# 终端观测验证记录

日期：2026-10-12。代码与验证位于 `/Users/luwentao/Workspaces/wechat-super-leader-bot`；没有部署香港、更新正式 Daemon、修改桌面连接方式或发送真实消息。

## 本轮交付

为宿主 Daemon 增加默认关闭的终端观测来源：显式配置 socket 与 pane 后发现已有 Agent 元数据，按用户请求读取有限输出快照。Controller 与 Web 明确区分该来源，阻止发送、模型推断以及将快照冒充对话历史。不是完整 CLI 控制实现。

实际协议依赖为 Herdr 0.9.0 / protocol 22。每次连接先校验版本，仅调用 `ping`、`agent.get`、`pane.read`。身份使用完整 SHA256 的 base64url 编码；读取前后复核原绑定与 revision，不以标题、焦点或文件路径猜测目标。

## 最终独立验证

主任务在修复完成、两个协作单元冻结后执行：

```text
node verify.mjs
[verify] PASS 15 checks (all); synthetic fixtures only, no production acceptance claimed.
exit 0
```

| 范围 | 最终结果 |
| --- | --- |
| Controller 单测、类型检查、构建 | 40 文件 / 557 tests，通过 |
| Gateway 单测与构建 | 104 tests，通过 |
| Web 单测与构建 | 15 文件 / 280 tests，通过 |
| 根 CLI、验证入口与测试工具 | 78 tests，通过 |
| `go test -race -count=1 ./...` | 全包通过；client 22.300s、codex 29.082s、terminal 4.546s |
| Go vet、本机构建、Linux amd64 无 CGO 构建 | 全部通过 |
| Compose 配置验证 | 9 tests，通过 |
| PostgreSQL / Controller / Go Daemon 整链 | 全部通过，包括新增终端来源 |
| PostgreSQL 控制台鉴权 | 8 阶段通过，包括单次兑换、1 小时有效期与重启持久化 |
| `git diff --check` | 退出 0 |

定向的 `node --test scripts/test-cleanup.test.mjs` 为 15/15 通过。两个协作单元分别验证观测器与 Daemon/配置/服务接线，并交叉复核；最终没有未解决的评审发现。这不替代上表主任务的全量验证。

整链证据：

```text
PASS real Go terminal observer → PostgreSQL Controller → Leader list/read tools; explicit snapshot, source failure/recovery, no history/send/native turn; default disabled probe
```

该用例使用临时 Unix socket、实际 Go Daemon、实际 PostgreSQL 与 Controller；终端和模型为合成协议端点。断言包括：

- 未配置时不接触终端；probe 不读取 token、不创建 journal，也不连接 Controller。
- 发现和列表不读终端正文；显式读取才返回带“终端快照”和裁剪提示的内容，不生成 turnId。
- 会话 ID 总长 52，真实 PostgreSQL 持久化通过；不公开 token、agent_session 等宿主私有字段。
- active → blocked → 来源失败 unknown → done 映射 idle；失败不更新旧状态的 observedAt。
- 两种 HTTP 发送入口均拒绝；历史返回明确不可用，Web 不发起或重试历史请求。
- 只调用三个允许的只读 RPC；没有 start、resume、prompt 或终端输入。

既有固定依赖计划仍只认精确 turn 的 completed。全套验证同时覆盖重启只读恢复、不重发、取消后不启动后继、通知结果未知不重放；新增终端生命周期没有放宽这些规则。

## 评审修正与解决的未知项

1. 首版接线曾等待首次终端发现再连 Controller。评审发现故障源可能让整节点重连延后 3–10 秒，已移除该门槛：先连接、发缓存 hello 与回执，再运行独立来源 worker。回归覆盖慢终端不阻塞原来源、心跳及回执，以及取消后 worker 收尾。
2. 配置层与观测器曾分别校验路径。现统一调用 `terminal.ValidateSelectors`，拒绝非法 UTF-8、控制字符、首尾空白、超长/非绝对 socket、非法或重复 pane；服务安装在写文件前校验。
3. 不能将宿主 idle/done 解释为某个派发任务已完成：静态 `agent.prompt` 契约不提供原生 turn ID。本轮保留只读边界，不调用该方法，也没有以推测完成状态换取发送能力。

## 实际调查与未证明事项

Mini 上仅检查安装版本、帮助及静态协议 schema，未读取焦点 pane 或真实终端输出。静态 schema 与传输实现交叉确认了 framing 和方法契约；合成测试证明当前代码按该契约运行，但不证明任意版本宿主兼容或 Mini 真实接入成功。

仍需用户指定一个明确的 Mini 测试终端。未完成真实终端验收、新版部署、CLI 发送/中断、完整历史或精确任务完成回执。Web 当前展示状态与只读说明；快照通过 Leader 显式 read_session 获取，不宣称已有 Web 终端快照浏览器。

启用参数为 `--terminal-sock /absolute/socket --terminal-pane wN:pN`，可重复指定 pane，最多 16 个；两参数必须成对。示例是参数形状，不是实际连接目标。状态每 15 秒刷新，45 秒后失效；单 RPC 3 秒、整次操作 10 秒有界。默认关闭，不自动寻找焦点或启动宿主。

## 清理与回退

最终验证后，通过统一入口的 `localDockerEnvironment` 限定本地引擎，再查询 `super-leader-test-` 与 `super-leader-console-test-` 容器，结果为空；临时目录中的 `slt-` 与 `super-leader-daemon-test-` 条目也为空。测试清理只针对自己创建的子进程、socket、目录与容器，清理失败会使验证失败。两个协作单元均已结束，没有新增真实验收会话。

没有创建备份、改生产数据库或读写真实凭据、微信游标及命令 journal。本轮代码仅本地交付，不包含 push 或部署。新来源默认关闭；未来若启用后需停用，移除对应的两类显式参数即可，不需迁移会话或修改其原后端。

建议经用户批准后将“来源发现不得阻塞节点活性”和“生命周期不等于任务回执”加入项目验收规范；本轮没有修改 CLAUDE.md、rules 或 skills。
