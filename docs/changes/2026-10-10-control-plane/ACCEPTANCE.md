# 完整目标验收清单

核对日期：2026-10-12。此文区分实现、测试与实际交付，不改变用户要求的完整范围。历史部署事实仍以对应记录的时间为准，不冒称本轮重新核验线上。逐轮命令与失败证据见 [VERIFICATION.md](VERIFICATION.md)。下述 201 项 Controller / 41 项 Web 为前轮工作台基线；最新本地历史版本为 Controller 369 项、Web 210 项，详见 [原桌面历史验收](../2026-10-12-desktop-history/VERIFICATION.md)。第二节点前置与注册加固见 [demomini 记录](../2026-10-11-demomini-onboarding/VERIFICATION.md)，不能把各轮数字相加或当作全目标完成。

## 不变架构

后续同日大快照修复：observer/control/history 入站统一 32 MiB，控制连接共享两槽、结构预算和重复引用拒绝已补齐；Go race/vet/Linux build、大帧跨层及真实只读通过。远端 `3488d3a` 与 节点 A `058af3d` 已发布，正式 Cookie 接口原会话发送、精确 turn、历史分页及重复请求验收通过，见 [当前发布状态](../2026-10-12-release-preflight/VERIFICATION.md)。原 [大快照验收](../2026-10-12-desktop-frame-budget/VERIFICATION.md) 保留开发期事实及内存测量限制。

发布状态更正：下表若仍出现“本地新代码尚未部署”“运行服务未更新”，均是对应开发阶段记录，不覆盖上述发布证据。原 owner 路由、模型、历史、任务计划视图与计划通知代码已随该版本发布；通知开关仍关闭，真实微信通知未验收。本轮新增的有序多技能组合尚未发布，单独记录于 [组合验证](../2026-10-12-ordered-skills/VERIFICATION.md)。

TypeScript Controller 是唯一控制权威，使用 PostgreSQL；TypeScript 微信 Gateway 是独立渠道进程；Go Daemon 在宿主机原生运行，通过主动连接 Controller 管理用户可见的既有会话；React/TypeScript Web 提供会话列表、结构化历史与受限发送工作台。Controller/PostgreSQL/Web 可在 Docker 内，Daemon 不在隔离环境创建 worker，不以历史 resume 冒充原会话附着。

## 验收矩阵

本轮新增统一 `node verify.mjs` 与 CI 配置，15 个检查阶段全部通过，包含真实临时 PG 整链与显式 `test-console-auth.mjs --run`。已修复 dotenv 自动读取和 CLOSED socket 清理死锁；本地 Node 26、CI 计划 Node 24，尚无 GitHub 运行结果。见 [可复现验证记录](../2026-10-12-reproducible-verification/VERIFICATION.md)，不替代下表未完成的实际交付门槛。

| 用户要求 | 当前证据 | 未达到的门槛 |
| --- | --- | --- |
| GitHub 私有仓库 | 已确认私有仓库；本地源码交付纳入根目录四组件、锁文件、验证入口、CI 配置及旧 Python 删除 | 尚未推送或运行 GitHub CI，不把本地提交当作新版已发布 |
| 本地项目与 Task 目录 | 源码已原地迁至 `~/Workspaces/wechat-super-leader-bot`，原生服务引用新路径；工作台复用验收会话 cwd 为项目目录；后续只读 IPC 已发现主任务 owner 并读取模型设置 | 当前及此前 5 个测试 Task 的绑定迁移仍为 0/6；先前 6 个目标的 no-client-found 不能代表当前所有 owner 不可用，仍未修改运行中状态；归档不等于迁移成功 |
| 微信扫码与接入 | 用户已确认收到前条测试消息；本人允许名单已加载；远端独立 Gateway 常驻 healthy、近期轮询成功且错误为 0；28 项离线测试通过 | 新常驻网关的真实入站→模型→微信回复仍待用户发消息验收；健康检查不等于全链路可用 |
| 微信自然语言指挥 | leaderMode=model、gpt-6.1-sol；Responses 工具闭环和模拟微信计划/确认/会话执行通过；正式 /v1/messages 模拟本人说“给我控制台链接”，12.093 秒返回 1 条链接，兑换/撤销均 200 | 此次是直接调用 Controller 的模拟入站，不冒称来自真实微信；新版工作台链接主动发送退出 1、投递未确认且未自动重发；微信内置浏览器点击体验待用户确认 |
| demoair 原会话管理 | 已部署版本完成专用原生会话两轮 Web 发送与精确终态；后续本地原 owner 路由已完成一次真实发送、精确 turn 回查、journal 重放保护；Controller/Web 固定路由集成通过；主任务真实模型、完整已记录历史最新/旧页/刷新均已验证 | 新原 owner 路由/历史/模型代码尚未更新运行服务；发送预检非原子、snapshot 无 nonce；不保证与 App 用户并发输入时无干扰，注销/休眠仍可能离线 |
| demomini 原会话管理 | 2026-10-11 只读核查确认 SSH/arm64/桌面 IPC/远端可达；纯文件发现临时实测找到 1 个会话，共享控制 socket 缺失；节点注册安全加固 35 项测试通过 | 尚未注册或安装正式 Daemon；最近探测该文件身份没有可用桌面 owner，不能仅以存在 IPC 或文件声称能控制。更改 App transport/启动共享后端/重启不再作为前提且未获授权，见 [文件发现验证](../2026-10-11-rollout-discovery/VERIFICATION.md) |
| 平台原生服务 | 单一 Go 管理入口；macOS LaunchAgent 实装，Linux systemd --user 参数/权限/生命周期单测及 amd64 交叉编译通过；卸载保留 token/journal | Linux 尚未实机安装；不自动开启 linger；macOS 文件日志轮转未配置 |
| 公司机器会话管理 | devbox/devsg 别名无法解析；devos 两次失败，macpro 跳板独立检查超时 | 可用连接入口、组织数据边界、远端协议与执行能力均未验证 |
| Codex App/CLI、Claude/Grok 等已有会话 | 既有 Codex 控制 socket 和桌面原 owner 均有独立接入；原 owner 专用 fixture 实发已验证，完整已记录历史及模型真实只读验证通过，见 [路由研究](DESKTOP_ROUTING.md) | 不覆盖所有独立终端宿主；Claude/Grok 原进程适配未实现，不以新 SDK/resume 会话冒充原会话附着。忙碌/审批竞争的原子拒绝仍未证实 |
| 技能体系 | demoair 发现 82 技能；真实模型查询返回准确 ID/digest；新建专用原会话实际读取 ai-scaffold-init、校验 SHA256 并执行只读 Verify，精确 completed 和 3 条成功工具记录已核验 | 仅验证该技能的只读场景，其他技能及其依赖尚未逐项执行；不证明所有技能都可运行 |
| 记忆 | PostgreSQL 聊天隔离/CAS；模型桩跨重启验证；真实模型模拟聊天的保存/回忆/忘记通过，直接查库核对写入和删除 | 真实微信体验与真实模型跨重启回忆未验收；旧记忆未迁移 |
| 主动管理 Leader/进度 | 本地已支持最多四步固定依赖计划、原子确认、24小时授权、自然语言进度/取消、重启查原回执；Web 已确认计划视图展示实时逐步进度、跨机依赖与精确会话跳转。新增完成/失败/授权到期的持久微信通知，默认关闭、只领取一次、结果不明不重发；Controller 538 项、Gateway 104 项及真实临时 PG/HTTP/WS＋模拟微信通过，见 [计划通知验证](../2026-10-12-plan-notifications/VERIFICATION.md)。Web 276 项及桌面/手机浏览器证据见 [计划视图验收](../2026-10-12-plan-console/VERIFICATION.md)，持久调度见 [持久计划验证](../2026-10-12-persistent-plans/VERIFICATION.md) | 本地新代码尚未部署，通知未真实微信验收；持续动态自治、跨会话结果传递/重新规划未完成。通知 accepted 非送达，领取后崩溃可能漏发；视图最多 12 条，非全部计划历史，不把固定 DAG 当作完整 Super Leader |
| Web 会话工作台与免密登录 | 已部署免密链接/精确会话发送；本地新版本完成模型来源展示、持续历史刷新和自动旧页加载、阅读锚点、固定historyContext及409显式恢复。最终Web 210项测试通过，真实合成浏览器操作和桌面/竖屏/横屏截图已留证 | 新体验与原桌面历史尚未部署。真实手机软键盘/微信内置浏览器未验收；横屏错误态历史区拥挤仍待改善。Cookie只开放指定读接口和受Origin/intent约束的精确发送，不提升管理权限 |
| 验收会话清理与复用 | 本轮原生 fixture、App 测试及此前 5 个已完成测试共 7 个精确会话已归档，归档列表独立确认、历史可恢复；创建连接与进程退出，测试登录退出、TaskSpace 关闭；后续优先复用 `c0863a5b-311c-5ab9-997b-be2e24fffb18` | 归档不删除历史；后续确需验收才显式恢复复用，writer 被占用时报告原因，不抢占或不断新建；当前 Task 与用户工作会话未归档 |
| 微信 Markdown | 文本降级、链接、代码、分段/续传、UTF-16 安全边界测试通过 | 真微信渲染未验收；组合字素仍可能跨段 |
| 可靠性与生产能力 | 前轮已验证 Controller 21 文件/201 项、Web 5 文件/41 项、Gateway 28 项、节点注册 CLI 16 项，此前 CLI/部署联合 35 项通过；该轮 Controller/Web typecheck、build、Daemon race/vet/build 及真实临时 PG 集成断言通过；其中 50 项 HTTP 测试覆盖历史往返、并发幂等、Cookie 写边界与派发前授权复验；工作台验收清理后 demoair connected、15 会话、13 命令、0 pending/accepted/uncertain，两条验收命令仍 completed | 后续回执校验修改须另行记录实际回归结果；压力、物理掉电、长期故障与灾难恢复仍待验证；单节点 PG、未建自动备份；安全审查不等于完整攻防保障，不宣称 exactly-once/生产就绪 |

## 下一阶段顺序

1. 已完成专用 demoair 会话真实发送、精确终态与幂等验证；工作台两轮发送复用 `c0863a5b-311c-5ab9-997b-be2e24fffb18`，该会话与另 6 个测试会话均已归档。后续确需测试才显式恢复该 fixture，不将其他工作会话当测试目标；writer 冲突时停止并报告。
2. 已完成用户授权的 gpt-6.1-sol 模型联调，不再需要重复询问模型选择；秘钥仅注入进程环境，不写仓库。
3. 本人 chatId 允许名单和远端 Gateway 已启用，由用户发自然语言消息，验收索取控制台链接、列会话、查询、计划确认、结果和记忆。新版工作台说明与链接的主动发送未确认成功；不自动重发、不为测试重置正常 checkpoint。账号登录不等于操作者授权。
4. 远端 `leader.example.com` 及 demoair 节点已上线，项目已原地移到 `~/Workspaces/wechat-super-leader-bot`。继续为其余机器分配独立凭证、注册原生 Daemon；公司机器先恢复访问入口并确认数据边界。Linux 需要补实机用户服务验收，跨机同名会话需补物理环境验收。
5. 在实际运行机制得到确认后补齐其他 CLI 适配和持续自治；保留原会话可见性，不引入隔离执行替代需求。
6. 用户已明确废弃旧代码：旧 Python 源码、测试和依赖入口已删除，不留双版本或兼容入口。数据库、微信凭证与 Daemon journal 保留。本地源码交付包含四组件与统一验证，具体提交以 Git 历史为准；已跟踪的旧版仍可在历史中查看，原先未提交的旧内容不承诺可恢复。未创建备份、推送或 PR。

## 完成判定

任何一行缺少真实要求对应的证据，完整目标都仍未完成。离线测试不能代替真实微信/模型/远端会话执行；本地已运行不能代替 GitHub 最新代码交付。当前不将目标标记 complete。
