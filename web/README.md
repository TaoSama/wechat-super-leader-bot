# Super Leader 会话工作台

React + TypeScript 前端。按机器浏览和搜索原有 Codex 会话，显示会话实际报告的模型、Provider、推理强度、目录、状态与更新时间。桌面使用双栏，手机使用列表与详情切换。

模型展示共用同一来源选择规则：优先过去 45 秒内可用的桌面设置，否则显示控制接口记录；不跨来源拼接 Provider/推理强度，不把全局默认模型当成会话模型。列表、详情、输入框提示和搜索同步更新，无新事件也会撤销过期桌面模型。详情展示“模型来源”和“模型观测时间”，全部未知时显示“模型未报告”。此展示不授予发送权限；本地实现尚未部署，见 [模型观测验收](../docs/changes/2026-10-11-desktop-model-observation/VERIFICATION.md)。

## 认证与发送边界

微信一次性链接在页面启动时立即清除地址栏 fragment/query，认证初始化共享单一 Promise，兑换 HttpOnly Cookie。浏览器不持有管理 Bearer token，也不保存凭证或草稿到任何本地存储。

仅在线、库存未过期且有有效发送路径的会话可以发送：控制接口需要明确 loaded=true、idle、send 和 45 秒内观测；独立桌面资格 `sendAvailability` 必须合法 ready、未超过 validUntil，且已有桌面观测可用/新鲜/idle。桌面资格不改写 native loaded/capabilities；非法、撤销或过期时禁止自动回退。UI 定时过期并在实际点击/Enter 时复验，回执展示服务端固定路线。此桌面路径已在本地接线，运行服务尚未更新。

入口为 POST /v1/sessions/:nodeId/:sessionId/messages，JSON 只包含 prompt 和 requestId，附带 X-Super-Leader-Intent: session-message；Origin 由浏览器自然生成并由 Controller 严格校验。浏览器不指定路线、不调用管理写入接口，也不隐式恢复未加载会话。

防连点与输入法保护。草稿按 nodeId/sessionId 在内存中隔离。网络返回不确定时保留原请求，用户手动恢复继续使用相同 requestId。accepted 仅表示受理，通过 GET /v1/commands/:id 查询到终态才确认结果；uncertain 不自动重发。退出或认证过期清除会话历史、草稿与发送状态。

## 历史与阅读

GET /v1/sessions/:nodeId/:sessionId/history 默认读取最新 30 条，通过 opaque cursor 加载更早的页。历史不生成 command。上一请求结束 2 秒后刷新，20 秒请求超时；没有固定次数上限，最多保留 2000 条并明确标记裁剪缺口，可重新读取最新页。隐藏页面/会话区或节点离线时暂停，恢复后继续；向上滚动自动读取更早页。切换会话中止旧请求并忽略迟到响应。

首次响应返回不透明 `historyContext` 和 `source`（`control-socket` / `codex-desktop`）。后续最新刷新与旧页均携同 context，cursor 不能单独使用。409 `history_context_expired` 保留已读消息，暂停轮询、分页和普通重试；详情顶部唯一的“重新读取最新页”入口显式建立新 context。502 `history_incomplete` 与 413 `history_too_large` 不冒充正文截断。浏览器取消或断开沿 Controller 传播至 Daemon 的精确 waiter，不取消其他读者共享缓存。桌面来源只承诺完整已记录历史，不合并未记录的临时 UI 状态。

react-markdown + remark-gfm 渲染结构化消息，禁原始 HTML；图片仅显示占位文字，外部图片不自动请求。工具详情展开时才渲染。阅读旧消息不被新快照拉回底部，加载更早页保留滚动位置，新消息提供显式跳转。如果新旧页无重叠，明确提示历史存在缺口。

运行状态与发送审计位于次要视图，保留真实节点在线/离线与命令五种状态，不将心跳视为消息完成证据。

## 开发与验证

```sh
pnpm --dir web install --frozen-lockfile
pnpm --dir web dev
pnpm --dir web typecheck
pnpm --dir web test
pnpm --dir web build
```

开发代理由 VITE_CONTROLLER_PROXY_TARGET 指定，默认 http://127.0.0.1:8790。生产 dist 可由 Controller 的 WEB_DIST_DIR 托管。无远程字体、CDN 或新增浏览器持久存储依赖。

浏览器合成验收可运行 `node web/tests/workspace-fixture.mjs`，仅监听 loopback 并禁用发送。对输出地址 POST `/fixture/model?mode=fresh|updated|expiring|unavailable|invalid|empty`（选择一个值）可通过 SSE 更新第一条合成会话；`expiring` 保留约 5 秒新鲜窗口，用于核对无后续事件时的降级。结束时 POST `/fixture/stop` 正常关闭，不连接生产系统。

历史固定来源、失效恢复与真实只读验收见 [历史验证记录](../docs/changes/2026-10-12-desktop-history/VERIFICATION.md)。手机横屏高度较低时，错误提示和详情头部会挤压消息区；恢复按钮已确认可见，但该状态的阅读空间仍有限。
