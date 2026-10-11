# 会话工作台

## 目标与边界

把状态监控页改成以原有会话为中心的工作台：按机器浏览与搜索会话，展示真实模型、状态、目录和更新时间，打开结构化历史，直接向具有有效发送资格的原会话发送消息。保留一次性链接与 HttpOnly Cookie；不向浏览器提供管理 token，不隐式 resume，不增加隔离 worker，不改变运行中会话。

## 实施顺序

1. 核对实际原生接口及会话交互，确定契约。
2. 并行实现 Daemon 数据、Controller 只读历史通道和 Web 工作台。
3. 增加浏览器专用发送入口与严格同源校验，复用持久化幂等命令路径。
4. 独立审查，运行单元/集成与真实浏览器测试。
5. 更新远端 Controller/Web 和 demoair Daemon，保留 PG 卷与 journal，验证真实测试会话；记录尚未证明的边界。

## 数据契约

Session 在既有字段上增加可选 `model`、`modelProvider`、`reasoningEffort`、`updatedAt`（ISO）、`preview`、`loaded`。仅使用原生 thread 返回值，不使用全局默认模型。未知模型显示未报告。

后续本地源码新增 `sendAvailability?: {route:"desktop-owner",state:"ready"|"blocked"|"unavailable",observedAt,validUntil,reason?}`。只有完整检查成功、有效期不超过 45 秒、当前桌面观测（如存在）可用且新鲜空闲，才可使用桌面路径；它不改写 native 字段。未提供此字段的控制接口路径仍要求 loaded=true、idle、send 和新鲜观测。路由由服务端选择，不接受 HTTP/模型提交 `sendRoute`；回执持久保存实际路线。详见 [跨层验证](../2026-10-11-desktop-send-route/VERIFICATION.md)，此新增能力尚未部署。

历史独立于命令：查询不生成持久化 command。Controller 向指定已认证节点发送：

```json
{"type":"read_history","requestId":"UUID","nodeId":"demoair","sessionId":"thread-id","cursor":"optional-opaque-cursor","limit":30}
```

Daemon 返回 `type: "history"`、同一 `requestId`、`sessionId`，以及成功时的 `history` 或失败时的静态 `error`。`history` 为：

```ts
interface SessionHistory {
  session: Session;
  items: HistoryItem[]; // oldest to newest within this page
  nextCursor: string | null; // older items
  fetchedAt: string;
  truncated: boolean;
}
interface HistoryItem {
  id: string;
  turnId: string;
  kind: "user" | "assistant" | "tool" | "system";
  type: string;
  text: string;
  title?: string;
  status?: string;
  timestamp?: string;
  truncated?: boolean;
}
```

使用已核实支持的原生 `thread/items/list`（experimentalApi）分页，`thread/read includeTurns:false` 获取元数据。限制 cursor 4096 字符、limit 1–50（默认 30），明确裁剪超长条目，不传未经挑选的原始对象或内部推理。接口不支持时明确报错，不走旧版兼容或读取全量 JSONL。历史请求绑定 socket 实例+节点+会话+requestId，超时、断连、取消均清理，有并发上限，不跨节点匹配。

## HTTP 与授权

- `GET /v1/sessions/:nodeId/:sessionId/history?cursor=&limit=` 返回 SessionHistory，允许 Cookie/Bearer，默认首屏最新 30 条。
- `POST /v1/sessions/:nodeId/:sessionId/messages` 仅接受 `{prompt,requestId}`，返回现有 CommandRecord。Cookie 写入必须 JSON、精确匹配 CONSOLE_PUBLIC_URL 的 Origin、`X-Super-Leader-Intent: session-message`，拒绝 cross-site/same-site fetch。管理 Bearer 仍独立认证。
- 新入口内部使用固定 `action:send` 和路径中的精确 nodeId/sessionId，幂等 requestId 由服务端加 `web_`+SHA256 命名空间，不能提交任意 action/skills。复用 CommandService，派发前再次校验会话登录有效。
- Cookie 仍禁止 `/v1/commands`、`/v1/messages`、`/v1/console-links` 等管理写操作。
- `GET /v1/commands/:id` 用于跟踪发送回执。accepted 不等于完成；uncertain 必须核查，禁止自动重发。

## Web 交互与验收

内容优先的深色双栏工作台：桌面左侧机器分组会话列表，右侧历史与输入框；手机列表/详情单栏切换且有返回入口。模型与状态作为会话核心信息，运维统计降级到次要区域。保留认证初始化单飞与地址栏清理。

选择会话仅拉取该会话历史；支持加载更早、工具详情折叠、Markdown 安全渲染（禁原始 HTML、外部图片默认不加载）；新快照不抢走阅读旧消息的滚动位置。历史刷新显示真实更新时间，不能伪装成 token 流式。同一时间仅有一个历史轮询请求，切换会话取消旧请求并隔离迟到响应。

输入草稿按 nodeId/sessionId 仅保存在内存。防连点、中文输入法 Enter 误发送；提交失败保留输入。网络不确定时保留同一个 requestId，用户手动核查/恢复且不会生成第二条命令。切换会话不会把旧内容发送给新会话。busy/notLoaded/offline/未知能力有明确不可发送原因。登录过期或退出清空历史及敏感状态。

当前验证状态（2026-10-11）：已实现并部署远端 Controller/Web 和 demoair Daemon。真实浏览器完成两轮原会话发送、Markdown 历史、分页、工具展开、草稿隔离、390×844 手机返回和登录退出验证；原生接口独立确认两个 turn completed 且仅含 userMessage/agentMessage。详见 VERIFICATION.md。

## 写入权与验收会话

控制 socket 的 loaded 状态不等于桌面 App 是否打开了该会话。早期实测 App 创建的专用会话为 notLoaded，显式 resume 返回 `already has an active writer`；不绕过锁、不自动 resume、不创建替代会话。后续改为独立核查并调用既有桌面 owner，而非争抢控制接口 writer。该路线已完成本地适配器真实发送和跨层 fixture 验证，但未部署；没有 owner 或有效资格的目标仍不可发送，不能承诺“在原 App 打开即可聊天”。

本轮在既有控制 socket 上建立一个专用原生会话并复用完成桌面、手机两轮发送，没有另起 app-server。测试完成已归档并关闭创建连接。优先复用的测试会话：`c0863a5b-311c-5ab9-997b-be2e24fffb18`，项目目录 `/Users/developer/Workspaces/wechat-super-leader-bot`。后续验收需要时才显式恢复它；若 writer 被占用应报告原因，不能抢占或不断新建。

本轮另一个 App 测试会话及此前 5 个已完成的专用验收会话均已归档，历史保留可恢复。浏览器测试登录已退出、TaskSpace 已关闭。截图接口重试失败，只有 DOM/交互证据，不宣称像素视觉或真实手机微信内置浏览器验收通过。
