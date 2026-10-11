# 可复现验证入口

日期：2026-10-12。范围是现有架构的源码交付与验证，不变更 Controller 编排权威、宿主会话所有权或生产服务。

## 入口与隔离

`node verify.mjs` 默认依次执行组件类型检查、单测、构建、CLI 工具测试、Go race/vet/本机构建/Linux 交叉编译、Compose 配置、真实临时 PostgreSQL 整链和一次性登录测试。`--suite unit` 不依赖 Docker；`--suite integration` 自动先构建；`--list`/`--help` 不探测 Docker、不执行测试。使用标准 `parseArgs`，命令为数组且 `shell:false`，cwd 来自脚本绝对位置。

子进程只继承工具、缓存、代理和 Docker 定位所需的明确环境白名单，不继承业务 token/model key、`LIVE_*`、journal crash helper 开关、`NODE_OPTIONS`、`GOFLAGS`。Go 平台/架构明确固定，`GOENV=off`。这不是文件系统或网络沙箱；工具自己的配置与缓存访问不在零访问承诺内。

新增显式 `SUPER_LEADER_NO_DOTENV=1`：Controller 模块导入时不调用 dotenv，Controller Vitest 与 Web Vite 使用 `envDir:false`。开关只影响文件加载，不跳过身份、数据库和模型配置验证；正常运行默认加载行为不变。入口总是设置该开关，不信任父进程的相反值。Compose 配置检查使用 `--env-file /dev/null`、`COMPOSE_DISABLE_ENV_FILE=true` 与合成环境白名单，不继承 Compose 文件/profile 选择器。

Docker 先只读解析 context endpoint，再将其固定为 `DOCKER_HOST` 并移除 `DOCKER_CONTEXT`；只接受绝对 `unix:///`，包括 localhost TCP 在内的 TCP/SSH endpoint 均拒绝。它不防御用户主动将本机 socket 转发到远端；不会修改 Docker context。

## 资源清理

`closeTestWebSocket` 只用于 harness 自建 socket：已 CLOSED 立即返回；先监听再 close；5 秒仍不关闭时只 terminate 该 socket 并报告超时。不会操作被发现的真实会话或其他进程。

`withTestCleanup` 包裹测试过程，逐项尝试登记资源的清理；某一项抛错不短路后续项。原断言错误和清理错误共同保留在 AggregateError 中。PG 初始化和 Controller.start 之前登记对象，避免启动中途失败遗失引用。中断入口时等待当前检查收尾再结束，不主动强杀进程。子进程永久不响应退出、SIGKILL、掉电和 Docker 控制调用结果未知不在完整回收保证内。

## 验证策略与 CI

- 合成 dotenv 验证禁止导入文件凭证且认证仍拒绝缺失值；正常加载分支作为对照。
- Web 使用真实 Vite 配置与合成四种 env 文件，监测 fs 读取次数：禁用为 0，普通 production 配置为 4。
- cleanup 回归覆盖 CLOSED、同步/异步 close、error、超时、终止失败、原断言失败，以及某项失败后继续回收。
- 临时 PG 登录验收必须带 `--run`，不把帮助信息退出 0 计为成功。
- GitHub workflow 使用固定 Action SHA、只读权限、Node 24、pnpm 11.8.0 与 go.mod 版本；Ubuntu 全套、macOS unit。正常手动运行不自动安装依赖；CI 的安装步骤与验证分开。

实际结果见 [VERIFICATION.md](VERIFICATION.md)。本机 Node 26 不能替代 Node 24 的远端 CI；配置 lint 也不证明 CI 已执行。旧 `Dockerfile.node` 指向已删除的根 TS 入口，前轮交付整理中已移除；不增加旧实现兼容层。

## 原会话接入核查与未完成项

当前安装 `codex-cli 0.162.1` 的帮助明确包含 `queue --thread --message`、`agents` 与 `app-server proxy --sock`；本轮仅执行 `--help`/`--version`，没有实际 queue、连接、启动或恢复。不能据此认定任意 CLI 原宿主已可控。

本轮检索并读取[官方线程文档](https://learn.chatgpt.com/docs/app-server#threads)：`thread/read` 不订阅或恢复，`thread/loaded/list` 只报告当前服务内存中的 ID，`thread/resume` 是恢复历史。文档没有建立新 queue 入口对于任意原终端的所有权或隐式启动保证；下步须核验具体终端宿主，不以新后端恢复代替原进程。

demomini 正式接入、公司机器可达性、其他 CLI 原进程适配、持续动态自治及微信真实入站仍未完成。本轮不部署远端服务、不更新已安装 节点 A Daemon、不更改桌面 transport、不读写真实 token/context/cursor/journal，不创建验收会话。完整目标保持 active。
