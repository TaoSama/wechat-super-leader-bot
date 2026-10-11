# Mac Mini 接入前置核查

核对时间：2026-10-11 12:53–13:11 UTC。上一轮 active 查询修复已上线，本轮推进第二物理节点，不把只读预检视为已经接入。

后续更正：下文“等待授权后先调整共享后端”的步骤是当时方案，不再作为当前接入前提。用户要求先核查已有运行时的接入做法，并未批准更改桌面 transport 或重启。后续只读索引实验因 WAL 副作用已撤回，保留了桌面探测公平调度修复；最新边界和验证见 [会话发现收口](../2026-10-11-independent-discovery/VERIFICATION.md)。Mini 尚未接入的事实不变。

再后续：纯文件发现已在 Mini 的原状下临时实测，发现 1 个持久化会话；没有可用桌面 owner 或发送能力，仍未注册、安装正式节点。最新源码、探测和清理证据见 [文件发现验证](../2026-10-11-rollout-discovery/VERIFICATION.md)。

## 当前事实

- `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=12 macmini` 直连成功，不需要 CF 备用通道。
- 当前远端用户为 `macmini`，HOME 为 `/Users/macmini`，UID 501；ComputerName 为 `Wentao’s Mac mini`，机型 `Mac16,10`、arm64。初次沿用 Mac Air 的 `/Users/luwentao` 路径检查失败，已通过远端 `id`、HOME 和真实目录独立纠正；不能将该路径错误算作机器离线。
- `/Applications/ChatGPT.app` 版本为 `26.1007.30912`，主进程与既有 Codex CLI 进程正在运行；`/Users/macmini/.codex/ipc/ipc.sock` 存在。
- 当前 `/Users/macmini/.codex/app-server-control/app-server-control.sock` 不存在。该目录仅有 startup lock 和旧 log。旧 log 为 10 月 9 日的 socket-in-use 错误，不能据此诊断当前占用。
- `lsof -n -a -p 1560,1906 -U` 只显示现有 Codex 进程的 stdio/无名 Unix 连接，未发现命名控制监听器；相同进程无 TCP listener。
- 内置 CLI 的只读 `codex app-server daemon version` 同样报 `failed to connect ... No such file or directory`。这与文件和进程通道交叉验证了当前控制接口不可用，非香港网络问题；Mac Mini 到 `https://leader.taoai.site/health` 返回 ok（13:01:47.777Z）。
- `/Users/macmini/Workspaces/wechat-super-leader-bot` 已有旧的 daemon 源码和构建产物，但不是 Git checkout。本轮未覆盖它们。没有本项目的 LaunchAgent、稳定安装二进制、项目 runtime state-dir 或默认 `~/.super-leader` 状态目录。
- 香港当前注册节点只有 `macair`。1Password 已存在独立 `Super Leader Node macmini` 条目；本轮只查询条目元数据，没有读取其 token、生成新 token 或更改注册配置。
- 远端 `~/.claude/skills` 存在，`ego-browser` 链接仍指向另一用户名的路径；`~/.agents/skills` 不存在。安装时不能照搬 Mac Air 的技能根目录，需再按远端实际目录核查。

## 桌面接口边界

复用只读协议研究 Agent；主任务独立读取当前 app.asar 的 registry 与连接条件。header SHA256 为 `0ba43368dc2f01fcf2a29c8e02f30cc6bb879ce268c8672734504f791526ce50`。

- 当前 IPC 注册的是 owner discovery 与 thread-follower 方法，没有无 ID 的 thread/list 或通用 host RPC。owner discovery 和运行状态订阅必须已有精确会话 ID；被动广播不构成完整 inventory。
- `.vite/build/src-BJv5Mk7n.js` byte 1540544/1540788 为注册表；thread/list 使用另一条 AppServer requestClient。不能把已有 IPC socket 当成现有 Daemon 所需的控制 socket。
- `.vite/build/application-network-startup-CfAQmSYg.js` byte 261000 的连接逻辑要求 `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1`、local host、无 config overrides、无强制 CLI/CLI 路径覆盖等条件，并检查已有 daemon 版本后才连接共享 socket；否则使用 stdio。该分支本身不创建监听器。
- 远端内置 CLI 的 `app-server daemon --help` 确认有 bootstrap/start/restart/stop/version 管理入口；本轮只运行帮助和 version，没有运行任何启动/配置/重启操作。`start --help` 不是 start 验收，不能声称已恢复接口。

仅安装 Super Leader Daemon 会得到无法发现会话的节点，不能据此算完成跨机管理。调整原桌面 transport、启动共享 app-server 或重启桌面应用属于新的运行环境变更，已向用户请求维护授权；未授权前不执行。后续即使获得授权，也必须先确认原任务无执行中工作，验证原会话 ID/历史保留及 writer 行为，不能将新建隔离 worker 当替代。

## 本轮代码改动

节点注册检查发现：原 `deploy/register-node.mjs` 接受含 `#`、`$` 或引号的新 token，写入无外引号的 NODE_TOKENS 时可能被 dotenv/Compose 截断或插值。没有修改真实凭证来复现。

现在两个入口（token 文件与导出的 `inspectAndPatchEnv`）共用安全格式校验：8–512 位 ASCII 字母、数字、`_`、`-`，不增加兼容分支。拒绝不安全字符时，env 原字节不变，不泄露输入，不留下临时文件。合法 hex/base64url 注册和幂等保留；其他旧节点及配置行不改变。格式安全不等于足够随机，正式新 token 仍应来自至少 32 个随机字节；已有节点不得未经核实换 token。

本轮只修改 `deploy/register-node.mjs`、`deploy/register-node.test.mjs` 及相关文档。注册工具尚未更新香港副本，运行配置没有变更。

## 主任务独立验证

| 命令 | 结果 |
| --- | --- |
| `node --test deploy/register-node.test.mjs deploy/config.test.mjs deploy/gateway.test.mjs deploy/authorize-wechat.test.mjs` | 35/35 通过，其中注册 19 项；合成文件自行清理 |
| `pnpm --dir controller exec vitest run tests/multi-node.test.ts tests/session-history-hub.test.ts tests/turn-hub.test.ts tests/commands.test.ts tests/command-state.test.ts tests/session-workspace-http.test.ts tests/resolver_security.test.ts` | 7 文件、81 tests 通过；覆盖节点/会话复合身份、错节点回执与请求隔离 |
| `cd daemon && go build -o bin/super-leader-daemon . && file bin/super-leader-daemon` | 构建通过，Mach-O arm64；未分发到 Mac Mini |
| `git diff --check` | 通过 |

保留既有脚手架及 `AGENTS.md -> CLAUDE.md -> README.md`，没有重复初始化。协作均复用已有 Agent，没有新增独立 Codex Task。没有新增验收会话、后台服务、临时脚本或备份，也没有杀进程、重启应用、修改系统配置、写数据库或发送微信消息。

## 未完成与下一步

Mac Mini 尚未注册或上线，没有取得第二节点会话读写验收。本轮首次确认的阻碍是其当前控制 transport；等待用户维护授权不代表整个项目暂停或完成。获得授权后先验证共享后端接入，再核对并复用独立凭证、dry-run 注册、排空后更新 Controller、安装 Mini 原生服务，最后跨至少 45 秒观察两节点心跳并核对精确会话。

若不调整桌面 transport，可另行实现只读 catalog + IPC 观测，但那只解决发现与状态，不等同原会话指挥能力。本轮未用这一较窄方案冒充完整目标。
