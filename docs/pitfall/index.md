# 已知限制

本页描述当前 TypeScript Controller/Gateway、Go Daemon 和 React Web；历史变更记录不代表当前入口。完整验收状态见 [验收清单](../changes/2026-10-10-control-plane/ACCEPTANCE.md)。

- 会话发现、状态观测和发送权限是三件事。读到历史或桌面显示空闲，不代表原控制接口 loaded，也不自动授予发送能力。
- 桌面原 owner 可通过本机 IPC 独立接入，不以更换 App transport 或另起后端为前提。该协议为内部接口；预检不是原子受理，不能保证与用户同时输入时无竞争。普通终端缺少已验证宿主控制接口时仍只读。
- Controller 是唯一编排权威，命令保存在 PostgreSQL；宿主 Daemon 主动建立认证 WebSocket，派发身份和回执保存在本机 journal。不要删除数据库或 journal 来解除重复实例锁或 uncertain。
- accepted 只代表受理。必须核查精确 sessionId/turnId 的终态；写后失联、回执缺失或身份不符时不自动重发，也不改投另一条路由。现有防重措施不是 exactly-once 保证。
- 固定依赖计划只在精确 completed 后推进，取消只停止后续派发，不终止已运行任务。后继任务不会自动吸收前项输出，持续动态自治尚未完成。
- 终态通知默认关闭；持久领取后结果不明不重发，因此崩溃可能漏通知。微信接口受理不等于送达或已读。
- 微信账号 token 不等于操作者授权；同一账号只在一个 Gateway 轮询。消息基线仅用于首次启用，正常重启不能重建基线或删除 checkpoint。
- 一次性控制台链接持有即可兑换，请勿转发；浏览器 Cookie 只允许指定读接口和受约束的精确会话发送，不提供管理权限。
- 微信 Markdown 由 Gateway 降级，真实微信渲染和内置浏览器仍需人工验收；组合字素可能跨段。

## 验证边界

`node verify.mjs` 使用合成模型、微信和桌面目标，真实临时 PostgreSQL 与组件整链不能替代物理跨机、真实微信、长期负载或断电恢复验收。新版本地代码也不代表运行服务已更新。命令和证据见 [统一验证记录](../changes/2026-10-12-reproducible-verification/VERIFICATION.md)。
