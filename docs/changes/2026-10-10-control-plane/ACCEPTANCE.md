# 完整目标验收清单

核对日期：2026-10-12，本轮核对的源码基线为 `7be6c26`。此文区分已实现、已验证、已部署与未证明，不改变用户要求的完整范围。部署以最近发布记录为准，不冒称本轮重新核验生产业务。逐轮命令与失败证据见 [VERIFICATION.md](VERIFICATION.md)。下述 201 项 Controller / 41 项 Web 为前轮工作台基线；最新本地回归为 Controller 703、Web 396、Gateway 104、CLI/工具 81 项，详见 [结果传递验收](../2026-10-12-plan-result-handoff/VERIFICATION.md)。不能把各轮数字相加或当作全目标完成。

## 不变架构

后续同日大快照修复：observer/control/history 入站统一 32 MiB，控制连接共享两槽、结构预算和重复引用拒绝已补齐；Go race/vet/Linux build、大帧跨层及真实只读通过。香港 `3488d3a` 与 Air `058af3d` 的发送、精确 turn、历史分页及重复请求验收保留为 [历史发布证据](../2026-10-12-release-preflight/VERIFICATION.md)。最近发布记录为香港 Controller/Web `a4ef93c`、Air Daemon `e1a6408`，原 owner 真实发送、有序两技能、正式 Cookie 历史回查及幂等均通过，见 [最近发布验收](../2026-10-12-ordered-skills-release/VERIFICATION.md)。原 [大快照验收](../2026-10-12-desktop-frame-budget/VERIFICATION.md) 保留开发期事实及内存测量限制。

发布边界：原 owner 路由、模型、已记录历史、有序多技能组合、固定依赖计划、计划 Web 与计划通知代码已有上述发布记录；通知开关仍关闭，真实微信通知未验收。main 中的 [终端单步输入](../2026-10-12-terminal-control-chain/VERIFICATION.md)、[Codex/Claude/Grok 可信记录历史](../2026-10-12-terminal-history/VERIFICATION.md) 和 [跨步骤结果传递](../2026-10-12-plan-result-handoff/VERIFICATION.md) 已源码实现并通过合成验收，尚未部署或通过真实 CLI/模型接力验收。

开发期证据仍保留：[桌面历史](../2026-10-12-desktop-history/VERIFICATION.md)、[技能组合](../2026-10-12-ordered-skills/VERIFICATION.md)、[文件发现](../2026-10-11-rollout-discovery/VERIFICATION.md)、[路由研究](DESKTOP_ROUTING.md)、[持久计划](../2026-10-12-persistent-plans/VERIFICATION.md)；其中旧部署状态不覆盖最近发布记录。

TypeScript Controller 是唯一控制权威，使用 PostgreSQL；TypeScript 微信 Gateway 是独立渠道进程；Go Daemon 在宿主机原生运行，通过主动连接 Controller 管理用户可见的既有会话；React/TypeScript Web 提供会话列表、结构化历史与受限发送工作台。Controller/PostgreSQL/Web 可在 Docker 内，Daemon 不在隔离环境创建 worker，不以历史 resume 冒充原会话附着。

## 验收矩阵

最新本地统一验证：`node verify.mjs --suite unit` 为 13 checks PASS，`--suite integration` 为 6 checks PASS，包含 Go race/vet、macOS/Linux 交叉构建及真实临时 PG/HTTP/WS 合成整链，见 [结果传递验收](../2026-10-12-plan-result-handoff/VERIFICATION.md)。统一入口与 CI 配置的初始证据保留于 [可复现验证记录](../2026-10-12-reproducible-verification/VERIFICATION.md)；尚无新版 GitHub CI 运行证据，不替代真实目标验收。

本轮主控只读观测（不作为业务验收）：`hostname/scutil/sysctl` 确认本机为 Air / Mac17,3；稳定 Daemon `--service status` 为 running / PID 29300，`go version -m` 为 `e1a6408fc65c53c78d00c7a982b67819bcf8351f`、`vcs.modified=false`、darwin/arm64。`git ls-remote --heads origin main` 返回 `8fc6114df302fc73e65fa1614187dabbc7f8fcb6`，`gh repo view` 返回 private / 默认 main。公网 `/health` 返回 `status:ok`（`2026-10-11T23:42:08.379Z`），仅证明 HTTP 存活，不证明香港镜像版本、Gateway、数据库或业务。本轮未读取生产凭据/数据库、推送、部署或发消息。

| 用户要求 | 当前证据 | 未达到的门槛 |
| --- | --- | --- |
| GitHub 私有仓库 | 本轮只读确认 private / 默认 main，远端 main 为 `8fc6114`；本轮核对的源码基线 `7be6c26` 包含四组件、锁文件、验证入口、CI 配置及旧 Python 删除 | 最新本地能力未证明已远端交付，尚无新版 GitHub CI 运行证据；本轮未推送 |
| 本地项目与 Task 目录 | 源码已原地迁至 `~/Workspaces/wechat-super-leader-bot`，原生服务引用新路径；工作台复用验收会话 cwd 为项目目录；后续只读 IPC 已发现主任务 owner 并读取模型设置 | 当前及此前 5 个测试 Task 的绑定迁移仍为 0/6；先前 6 个目标的 no-client-found 不能代表当前所有 owner 不可用，仍未修改运行中状态；归档不等于迁移成功 |
| 微信扫码与接入 | 用户曾确认收到前条测试消息；本人允许名单已加载；最近发布记录中香港独立 Gateway healthy、轮询成功且错误为 0，见 [发布验收](../2026-10-12-ordered-skills-release/VERIFICATION.md) | 真实入站→模型→微信回复仍待用户发消息验收；历史健康检查及本轮 HTTP 存活不等于全链路可用 |
| 微信自然语言指挥 | leaderMode=model、gpt-6.1-sol；Responses 工具闭环和模拟微信计划/确认/会话执行通过；正式 /v1/messages 模拟本人说“给我控制台链接”，12.093 秒返回 1 条链接，兑换/撤销均 200 | 此次是直接调用 Controller 的模拟入站，不冒称来自真实微信；新版工作台链接主动发送退出 1、投递未确认且未自动重发；微信内置浏览器点击体验待用户确认 |
| Mac Air 原会话管理 | 最近发布记录确认原 owner 路由/模型/历史及有序技能已部署；专用原会话真实发送、精确 turn、journal 重放保护、正式 Cookie 历史最新/旧页/刷新与重复请求均通过，见 [发布验收](../2026-10-12-ordered-skills-release/VERIFICATION.md)。本轮只读确认稳定 Daemon 仍为 `e1a6408` / running | 发送预检非原子、snapshot 无 nonce；不保证所有 owner 均可用，或与 App 用户并发输入时无干扰；注销/休眠及长期运行仍可能离线 |
| Mac Mini 原会话管理 | 历史 SSH/arm64/桌面 IPC/香港可达；最近精确 targetID 仍持久存在，本机 IPC initialize 成功，两次 owner discovery 均超时，见 [最近 owner 核查](../2026-10-12-macmini-owner-check/VERIFICATION.md)；注册加固历史测试保留于 [前置记录](../2026-10-11-macmini-onboarding/VERIFICATION.md) | 未安装/注册正式节点，原会话状态、历史和发送均未证明；timeout 不是 no-client-found，更不是全机无 owner 的证明。不以文件或 IPC 存在声称可控制，也不擅自更改 App transport、启动共享后端或重启 |
| 平台原生服务 | 单一 Go 管理入口；macOS LaunchAgent 实装，Linux systemd --user 参数/权限/生命周期单测及 amd64 交叉编译通过；卸载保留 token/journal | Linux 尚未实机安装；不自动开启 linger；macOS 文件日志轮转未配置 |
| 公司机器会话管理 | 历史核查中 devbox/devsg 别名无法解析；devos 两次失败，macpro 跳板独立检查超时 | 可用连接入口、组织数据边界、远端协议与执行能力均未验证 |
| Codex App/CLI、Claude/Grok 等已有会话 | Codex 桌面原 owner 已真实验收；Codex/Claude/Grok 显式可信绑定的只读记录历史与 opt-in 终端单步输入已源码实现，真实 Go/Controller/临时 PG/Web 合成链通过，见 [历史验收](../2026-10-12-terminal-history/VERIFICATION.md) 与 [输入验收](../2026-10-12-terminal-control-chain/VERIFICATION.md)。Grok 仅返回文本片段，不虚构完整轮次 | 终端能力未部署、未配置真实历史目录或经真实 CLI 验收；输入默认关闭，需显式 non-atomic、目标 pane/socket 与真实 journal。input-written 仅证明写入，不是精确任务完成，不能参与多步/依赖/resultFrom；不以 SDK/resume 冒充附着，忙碌/审批竞争的原子拒绝未证实 |
| 技能体系 | 最近发布记录发现 83 技能，最多 4 个有序技能已部署；真实原会话依次完整读取两技能并核验 SHA256，精确 completed/turn、正式历史回查、相同请求不重发及反序 409 均通过，见 [组合发布验收](../2026-10-12-ordered-skills-release/VERIFICATION.md) | 仅证明所验技能的只读组合场景；SHA256 只绑定 SKILL.md，不冻结依赖目录，其他技能及复杂业务尚未逐项执行 |
| 记忆 | PostgreSQL 聊天隔离/CAS；模型桩跨重启验证；真实模型模拟聊天的保存/回忆/忘记通过，直接查库核对写入和删除 | 真实微信体验与真实模型跨重启回忆未验收；旧记忆未迁移 |
| 主动管理 Leader/进度 | 最多四步固定依赖计划、原子确认、24小时授权、进度/取消、重启查原回执、计划 Web 和通知代码已有最近发布记录。计划视图与通知合成证据见 [计划视图](../2026-10-12-plan-console/VERIFICATION.md)、[通知验证](../2026-10-12-plan-notifications/VERIFICATION.md)。main 新增显式 resultFrom：同计划直接前驱的精确 completed 输出随 CAS 冻结，重启不重采样/重发；真实临时 PG/生产 Scheduler/两合成节点及浏览器通过，见 [结果传递验收](../2026-10-12-plan-result-handoff/VERIFICATION.md) | 通知开关仍关闭，未真实微信外发验收；结果传递未部署、未真实模型接力验收。持续动态自治/重新规划仍未实现，不把固定 DAG 当作完整 Super Leader。通知 accepted 非送达，领取后崩溃可能漏发；视图最多 12 条，非全部计划历史 |
| Web 会话工作台与免密登录 | 最近发布记录包含免密链接、精确发送、模型来源、原桌面历史持续刷新/旧页加载、阅读锚点、固定 historyContext/409 恢复及计划视图；真实原会话与合成浏览器证据分别见 [发布验收](../2026-10-12-ordered-skills-release/VERIFICATION.md)、[计划视图](../2026-10-12-plan-console/VERIFICATION.md)。main 中终端历史/输入与结果来源界面已通过合成浏览器验收 | 新终端与结果来源能力未部署；真实手机软键盘/微信内置浏览器未验收，横屏错误态历史区拥挤仍待改善。计划 DTO/微信摘要不展示结果附件正文，认证命令详情仍保留实际请求；Cookie 只开放指定读接口及受 Origin/intent 约束的精确发送，不提升管理权限 |
| 验收会话清理与复用 | 此前原生 fixture、App 测试及此前 5 个已完成测试共 7 个精确会话已归档，归档列表独立确认、历史可恢复；创建连接与进程退出，测试登录退出、TaskSpace 关闭；后续优先复用 `01a12a91-5777-75e0-8df3-4ee968565997` | 归档不删除历史；后续确需验收才显式恢复复用，writer 被占用时报告原因，不抢占或不断新建；当前 Task 与用户工作会话未归档 |
| 微信 Markdown | 文本降级、链接、代码、分段/续传、UTF-16 安全边界测试通过 | 真微信渲染未验收；组合字素仍可能跨段 |
| 可靠性与生产能力 | 历史 Controller 201/Web 41 工作台基线与清理后状态见 [原验证](VERIFICATION.md)；最新本地 unit 13/integration 6 checks PASS，Controller 703/Web 396/Gateway 104/CLI工具 81、Go race/vet 与 macOS/Linux 构建通过，见 [最新回归](../2026-10-12-plan-result-handoff/VERIFICATION.md)。最近发布记录另有精确命令、幂等和历史回查证据 | 本地/合成回归不等于生产负载保障；压力、物理掉电、长期故障与灾难恢复仍待验证；单节点 PG、未建自动备份；安全审查不等于完整攻防保障，不宣称 exactly-once/生产就绪 |

## 下一阶段顺序

1. 已完成专用 Mac Air 会话真实发送、精确终态与幂等验证；工作台两轮发送复用 `01a12a91-5777-75e0-8df3-4ee968565997`，该会话与另 6 个测试会话均已归档。后续确需测试才显式恢复该 fixture，不将其他工作会话当测试目标；writer 冲突时停止并报告。
2. 已完成用户授权的 gpt-6.1-sol 模型联调，不再需要重复询问模型选择；秘钥仅注入进程环境，不写仓库。
3. 本人 chatId 允许名单和香港 Gateway 已启用，由用户发自然语言消息，验收索取控制台链接、列会话、查询、计划确认、结果和记忆。新版工作台说明与链接的主动发送未确认成功；不自动重发、不为测试重置正常 checkpoint。账号登录不等于操作者授权。
4. 香港 `leader.taoai.site` 及 Mac Air 节点已上线，项目已原地移到 `~/Workspaces/wechat-super-leader-bot`。继续为其余机器分配独立凭证、注册原生 Daemon；公司机器先恢复访问入口并确认数据边界。Linux 需要补实机用户服务验收，跨机同名会话需补物理环境验收。
5. 对已实现但未部署的终端单步输入、可信记录历史和结果传递补真实目标验收，再推进其他 CLI 精确完成证明及持续动态自治/重新规划；保留原会话可见性，不引入隔离执行替代需求。
6. 用户已明确废弃旧代码：旧 Python 源码、测试和依赖入口已删除，不留双版本或兼容入口。数据库、微信凭证与 Daemon journal 保留。本地源码交付包含四组件与统一验证，具体提交以 Git 历史为准；已跟踪的旧版仍可在历史中查看，原先未提交的旧内容不承诺可恢复。未创建备份、推送或 PR。

## 完成判定

任何一行缺少真实要求对应的证据，完整目标都仍未完成。离线测试不能代替真实微信/模型/远端会话执行；本地已运行不能代替 GitHub 最新代码交付。本次验收文档校正不代表生产完工，当前不将完整目标标记 complete。
