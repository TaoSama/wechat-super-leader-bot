# 控制台一次性登录

## 需求与边界

用户通过微信自然语言索取控制台入口，或由已授权的助手主动发送。链接签发后有效 1 小时，只能兑换一次；打开时自动登录并立即清理地址栏中的凭证，不要求手输管理 token。不保留旧的浏览器管理 token 登录入口。

链接持有者在兑换前具有登录能力，因此只向已核实的本人对话发送，不要转发。链接不是对微信身份的再次证明；若链接被其他人先打开，本人需要重新索取。微信端对 fragment 链接的实际打开行为需用户最终验收。

## 认证链路

```text
本人微信请求 → Leader 调用 get_console_link
                           ↓
                  Controller 签发一次性链接
                           ↓
微信中的 HTTPS /#login=... → 浏览器立即 replaceState 清理 URL
                           ↓ POST /auth/exchange（JSON 正文）
                  PostgreSQL 原子消费链接 + 创建登录态
                           ↓
             Secure / HttpOnly / SameSite=Strict cookie
                           ↓
                只读控制台 GET API，1 小时后过期
```

- 链接凭证使用独立命名空间的 256-bit HMAC 派生；同签发 requestId 重试不改变原失效时间，不复活已使用链接。登录态使用独立随机凭证。
- 登录表只存凭证的 SHA-256 摘要，不存原始 token；兑换与创建登录态同一事务，并发最多成功一次，服务重启不重置。
- `CONSOLE_PUBLIC_URL` 是明确配置的公开 origin，香港为 `https://leader.taoai.site`；不按外部 Host 头猜测签发地址。生产仅 HTTPS，本地开发仅允许 loopback HTTP。
- URL fragment 不随普通 HTTP 请求发送。前端在启动时同步清理 URL，再兑换；不写 localStorage/sessionStorage，不打印链接或 token。服务与 HTML 禁止缓存并设置 no-referrer。
- cookie 只授权状态、技能目录及命令记录的 GET，不能 POST 命令、微信消息、签发链接，也不能连接 Daemon。原管理 Bearer 仅供受信机器调用，不下发浏览器。
- 登录态固定 1 小时，刷新可继续，退出撤销当前登录态；不做滑动续期。失效后页面提示去微信重新索取。
- 模型只得到签发成功及失效时间；真实 URL 由 Controller 拼进最终微信回复，不进入模型工具结果或后续聊天历史。为幂等回复保留的消息/回执可能含短期链接，仍属于受保护业务数据，不能据此声称整个数据库只有摘要。

## 验证门槛

1. 未认证者无法签发；错误、已用与过期 token 统一拒绝，日志不泄漏 token。
2. 并发兑换只成功一次，重启后仍不可重复使用；失败事务不丢有效链接。
3. cookie 可看状态，不能派发或签发；跨 origin 写请求拒绝。
4. 浏览器打开立即清 URL，React StrictMode 不重复兑换；刷新保留登录、退出清数据；过期后停止状态轮询。
5. 真 HTTPS 部署验证后，向本人微信发送一条新链接，由用户最终确认微信内打开体验。

实现与实际部署证据记录在 VERIFICATION.md；本设计不等同于已完成验证。
