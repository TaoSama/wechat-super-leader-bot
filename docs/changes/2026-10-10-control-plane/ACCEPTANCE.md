# 完整目标验收清单

2026-10-13增量：香港Controller已更新至79b8b34，历史查询与快照串行化见 [查询验收](../2026-10-12-leader-session-history/VERIFICATION.md) 和 [持久化验收](../2026-10-13-node-session-persistence.md)；最近已完成CI基线aead4f8。两机Daemon均为ef32a2f，Mini现已通过原owner状态、历史分页与发送资格，实际发送仍未验证，见 [Mini验收](../2026-10-13-macmini-owner-activation.md)。下面10-12的版本、数量与运行身份保留为历史基线，不覆盖这些增量。

核对日期：2026-10-12。产品发布源码 `f6b2b5d`，已推送的 CI 通过基线 `7965626`；本轮实际重新核验香港、Air、Mini、真实模型结果接力及浏览器。此文区分已实现、已验证、已部署与未证明，不改变完整范围。最近证据见 [正式发布记录](../2026-10-12-authorized-release/VERIFICATION.md)，逐轮历史见 [VERIFICATION.md](VERIFICATION.md)。Controller 703、Gateway 104、CLI/工具 81 项为前轮回归，Web 新增真实形态回归后 400 项；不能把各轮数字相加或当作全目标完成。

## 不变架构

同日大快照修复：observer/control/history 入站统一 32 MiB，控制连接共享两槽、结构预算和重复引用拒绝已补齐；Go race/vet/Linux build、大帧跨层及真实只读通过。香港 `3488d3a` / Air `058af3d` 的 [历史发布证据](../2026-10-12-release-preflight/VERIFICATION.md)，以及后续香港 `a4ef93c` / Air `e1a6408` 的 [有序技能发布验收](../2026-10-12-ordered-skills-release/VERIFICATION.md) 均保留为历史证据，不代表当前运行版本。原 [大快照验收](../2026-10-12-desktop-frame-budget/VERIFICATION.md) 保留开发期事实及内存测量限制。

当前发布边界：香港 Controller/Web、Air 与 Mini Daemon 已部署 f6b2b5d；通知开关仍关闭，真实微信通知未验收。[终端单步输入](../2026-10-12-terminal-control-chain/VERIFICATION.md)、[Codex/Claude/Grok 可信记录历史](../2026-10-12-terminal-history/VERIFICATION.md) 代码随包部署但未配置真实目标或开启发送。[跨步骤结果传递](../2026-10-12-plan-result-handoff/VERIFICATION.md) 已通过同一真实 Air 原会话的两步模型接力；不是不同物理机验收。

产物：f6b2b5d 的linux/amd64 Controller/Web镜像已正式运行，Mini使用该版arm64只读Daemon；Air后续更新至ef32a2f（产品修复9ef6647）。香港未构建，PG/Gateway容器未替换，token/journal/checkpoint保留。首次烟测OOM和驱动DTO错误均保留在 [候选记录](../2026-10-12-release-candidate/VERIFICATION.md)。历史reader正常广播累计误判已修复；正式浏览器242秒/97次读取及直聊通过，但不代表多天长稳。

开发期证据仍保留：[桌面历史](../2026-10-12-desktop-history/VERIFICATION.md)、[技能组合](../2026-10-12-ordered-skills/VERIFICATION.md)、[文件发现](../2026-10-11-rollout-discovery/VERIFICATION.md)、[路由研究](DESKTOP_ROUTING.md)、[持久计划](../2026-10-12-persistent-plans/VERIFICATION.md)；其中旧部署状态不覆盖最近发布记录。

TypeScript Controller 是唯一控制权威，使用 PostgreSQL；TypeScript 微信 Gateway 是独立渠道进程；Go Daemon 在宿主机原生运行，通过主动连接 Controller 管理用户可见的既有会话；React/TypeScript Web 提供会话列表、结构化历史与受限发送工作台。Controller/PostgreSQL/Web 可在 Docker 内，Daemon 不在隔离环境创建 worker，不以历史 resume 冒充原会话附着。

## 验收矩阵

最新 GitHub CI run [38262955582](https://github.com/TaoSama/wechat-super-leader-bot/actions/runs/38262955582) 全通过：Ubuntu all 16 checks、macOS unit 13 checks，包含 Go race/vet、平台构建与真实临时 PG/HTTP/WS 合成整链。前两轮时钟、fixture 连接寿命、Compose 序列化测试失败及修复保留在 [发布记录](../2026-10-12-authorized-release/VERIFICATION.md)。这些测试仍不替代真实目标验收。

本轮正式验证：香港Controller容器`4460349d838a`未替换，Air更新历史修复后PID437，Mini仍PID90884；产物SHA256与各自固定候选一致。两节点真实WSS认证连接、共165技能。接力和最终Web验收后全量状态为21命令（19completed/2failed）、1completed计划、1未领取pending通知，无未决项。浏览器旧页刷新后计划来源正常；持续历史修复、正式读取及直聊均通过。复用fixture已归档并从正式列表消失。

| 用户要求 | 当前证据 | 未达到的门槛 |
| --- | --- | --- |
| GitHub 私有仓库 | private / 默认 main；已推送至 `7965626`，四组件、锁文件、验证入口及旧 Python 删除已交付；Ubuntu/macOS CI 全通过 | 后续补丁须重新提交、推送并验证，旧绿测不证明新 diff |
| 本地项目与 Task 目录 | 源码已迁至 `~/Workspaces/wechat-super-leader-bot`，原生服务和复用验收会话 cwd 正确；主任务已归属该项目 | 项目归属 1/6、原有 cwd 迁移 0/6。首个已归档测试 Task 的移动接口返回 `The task is not available in the sidebar.`，未继续更改其余目标、未解归档或写 DB；归属不等于 cwd |
| 微信扫码与接入 | 用户曾确认收到前条测试消息；本人允许名单已加载；最近发布记录中香港独立 Gateway healthy、轮询成功且错误为 0，见 [发布验收](../2026-10-12-ordered-skills-release/VERIFICATION.md) | 真实入站→模型→微信回复仍待用户发消息验收；历史健康检查及本轮 HTTP 存活不等于全链路可用 |
| 微信自然语言指挥 | leaderMode=model、gpt-6.1-sol；Responses 工具闭环和模拟微信计划/确认/会话执行通过；正式 /v1/messages 模拟本人说“给我控制台链接”，12.093 秒返回 1 条链接，兑换/撤销均 200 | 此次是直接调用 Controller 的模拟入站，不冒称来自真实微信；新版工作台链接主动发送退出 1、投递未确认且未自动重发；微信内置浏览器点击体验待用户确认 |
| Mac Air 原会话管理 | 已更新历史修复ef32a2f；真实两步接力command/turn/SHA256与原生历史一致，重复确认20→20；修复后97次浏览器历史请求无失败，Web直聊精确完成 | 发送预检非原子、snapshot无nonce；30秒观察窗口会重新检查资格。不保证所有owner可用、并发人工输入无干扰或长期在线 |
| Mac Mini 原会话管理 | 独立节点凭据、LaunchAgent与真实WSS已完成；正常原生打开唯一既有目标后，独立probe与正式HTTP证明原owner状态/模型/历史分页。ef32a2f更新后显式启用desktop-send并取得有效ready资格；详见 [增量验收](../2026-10-13-macmini-owner-activation.md) | 尚未往Mini工作会话发送测试消息，不宣称真实发送/精确终态或跨物理机结果接力通过；正常App页面会自行加载既有会话，未改transport、另起共享后端或重启App |
| 平台原生服务 | 单一 Go 管理入口；macOS LaunchAgent 实装，Linux systemd --user 参数/权限/生命周期单测及 amd64 交叉编译通过；卸载保留 token/journal | Linux 尚未实机安装；不自动开启 linger；macOS 文件日志轮转未配置 |
| 公司机器会话管理 | 历史核查中 devbox/devsg 别名无法解析；devos 两次失败，macpro 跳板独立检查超时 | 可用连接入口、组织数据边界、远端协议与执行能力均未验证 |
| Codex App/CLI、Claude/Grok 等已有会话 | Codex 桌面原 owner 已真实验收；Codex/Claude/Grok 可信绑定的记录历史与 opt-in 单步输入代码已部署；Go/Controller/临时 PG/Web 合成链通过，见 [历史](../2026-10-12-terminal-history/VERIFICATION.md) 与 [输入](../2026-10-12-terminal-control-chain/VERIFICATION.md) 验收。Grok 只返回文本片段 | 终端来源和发送未启用，未配置真实记录目录/明确pane或经真实CLI验收。input-written不等于精确完成，不能参与多步/依赖/resultFrom；非原子竞争仍存在，不以resume冒充附着 |
| 技能体系 | 两节点正式状态发现共165项技能；最多4个有序技能已部署。原会话完整读取两技能、核验SHA256、精确turn、同请求不重发及反序409的证据见 [组合发布验收](../2026-10-12-ordered-skills-release/VERIFICATION.md) | 仅证明所验技能的只读组合场景；SHA256只绑定SKILL.md，不冻结依赖目录，其他技能及复杂业务尚未逐项执行 |
| 记忆 | PostgreSQL 聊天隔离/CAS；模型桩跨重启验证；真实模型模拟聊天的保存/回忆/忘记通过，直接查库核对写入和删除 | 真实微信体验与真实模型跨重启回忆未验收；旧记忆未迁移 |
| 主动管理 Leader/进度 | 最多四步固定依赖计划、原子确认、24小时授权、进度/取消、重启核查和Web均已部署；显式resultFrom已完成同一Air原会话的真实模型两步接力，精确结果与冻结hash验证通过。合成跨节点证据见 [结果传递验收](../2026-10-12-plan-result-handoff/VERIFICATION.md) | 通知开关仍关闭、1条pending未领取；不同物理机接力与真微信通知未验收。持续动态自治/重新规划未实现，不把固定DAG当完整Super Leader。通知accepted非送达，领取后崩溃可漏发；视图最多12条 |
| Web 会话工作台与免密登录 | 正式一次性链接无地址栏凭据、HttpOnly且storage为空；新版显示两节点、模型、计划2/2与28字符来源。旧标签页刷新后恢复；400项Web回归通过。修复后持续242秒历史、旧阅读位置保留、直接发送与logout401均通过 | 真实手机软键盘/微信内置浏览器未验收；本fixture不足30条，本轮未触发自动旧页加载（固定旧cursor已实测）。Cookie仅指定读接口与受Origin/intent约束的精确发送；认证命令详情仍含实际请求 |
| 验收会话清理与复用 | 此前原生 fixture、App 测试及此前 5 个已完成测试共 7 个精确会话已归档，归档列表独立确认、历史可恢复；创建连接与进程退出，测试登录退出、TaskSpace 关闭；后续优先复用 `01a12a91-5777-75e0-8df3-4ee968565997` | 归档不删除历史；后续确需验收才显式恢复复用，writer 被占用时报告原因，不抢占或不断新建；当前 Task 与用户工作会话未归档 |
| 微信 Markdown | 文本降级、链接、代码、分段/续传、UTF-16 安全边界测试通过 | 真微信渲染未验收；组合字素仍可能跨段 |
| 可靠性与生产能力 | 历史 Controller 201/Web 41 工作台基线与清理后状态见 [原验证](VERIFICATION.md)；最新本地 unit 13/integration 6 checks PASS，Controller 703/Web 396/Gateway 104/CLI工具 81、Go race/vet 与 macOS/Linux 构建通过，见 [最新回归](../2026-10-12-plan-result-handoff/VERIFICATION.md)。最近发布记录另有精确命令、幂等和历史回查证据 | 本地/合成回归不等于生产负载保障；压力、物理掉电、长期故障与灾难恢复仍待验证；单节点 PG、未建自动备份；安全审查不等于完整攻防保障，不宣称 exactly-once/生产就绪 |

## 下一阶段顺序

1. 已完成专用 Mac Air 会话真实发送、精确终态与幂等验证；工作台两轮发送复用 `01a12a91-5777-75e0-8df3-4ee968565997`，该会话与另 6 个测试会话均已归档。后续确需测试才显式恢复该 fixture，不将其他工作会话当测试目标；writer 冲突时停止并报告。
2. 已完成用户授权的 gpt-6.1-sol 模型联调，不再需要重复询问模型选择；秘钥仅注入进程环境，不写仓库。
3. 本人 chatId 允许名单和香港 Gateway 已启用，由用户发自然语言消息，验收索取控制台链接、列会话、查询、计划确认、结果和记忆。新版工作台说明与链接的主动发送未确认成功；不自动重发、不为测试重置正常 checkpoint。账号登录不等于操作者授权。
4. 香港 `leader.taoai.site` 及 Mac Air 节点已上线，项目已原地移到 `~/Workspaces/wechat-super-leader-bot`。继续为其余机器分配独立凭证、注册原生 Daemon；公司机器先恢复访问入口并确认数据边界。Linux 需要补实机用户服务验收，跨机同名会话需补物理环境验收。
5. 对已部署但未启用的终端单步输入和可信记录历史补真实目标验收，为结果传递补不同物理节点证明，再推进其他CLI精确完成及持续动态自治/重新规划；保留原会话可见性，不引入隔离执行替代需求。
6. 用户已明确废弃旧代码：旧Python源码、测试和依赖入口已删除，不留双版本或兼容入口。数据库、微信凭证与Daemon journal保留。四组件与统一验证已推送GitHub，具体提交以Git历史为准；已跟踪的旧版仍可在历史中查看，原先未提交的旧内容不承诺可恢复。未创建备份或PR。

## 完成判定

任何一行缺少真实要求对应的证据，完整目标都仍未完成。离线测试不能代替真实微信/模型/远端会话执行；本地已运行不能代替 GitHub 最新代码交付。本次验收文档校正不代表生产完工，当前不将完整目标标记 complete。
