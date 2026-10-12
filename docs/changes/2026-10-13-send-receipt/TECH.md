# 微信发送响应判定

## 问题与证据边界

原实现仅对通知要求顶层 `ret` 或 `errcode` 显式等于数字零，普通回复却接受 HTTP 成功的空 JSON 对象。已独立核对公开协议客户端的实现、类型、成功测试及发布包：发送响应的 `ret` 可以缺失，HTTP 200 / `{}` 属于客户端支持的成功形态。因此通知专用的严格开关会误拒绝这种响应。

这不证明之前两次真实 `ILinkSendMessageError` 的响应就是 `{}`：没有保存原始响应，无法进一步归因，也不能推导手机收到。旧通知仍保留原 `uncertain` 和 attempt，不重发、不回填、不改写。

## 单一合同

- 普通回复和通知共享 `validateSendReceipt`，删除 `strictReceipt` 选项，不留旧模式。
- 先要求 HTTP 成功及合法 JSON 对象；空 HTTP 正文、非法 JSON、数组、null 不是空对象。
- 支持字段限于 `ret`、`errcode`、`message_id`、`errmsg`。`{}`、仅合法 message_id、空 errmsg 均可省略成功码。
- 已出现的每个码必须是安全整数且为零，不转换字符串/null/布尔值。任一码非零即拒绝，即使另一码是零。
- message_id 若出现，需非空字符串或非负整数；数字只做形态检查，不被当作无损消息身份或送达证明。
- errmsg 若出现需字符串；无显式零码却出现非空文本时结果含糊，拒绝。
- 未知字段/envelope 保持保守拒绝，不读取其他接口的嵌套错误结构作为成功证明。这是本产品支持范围，不声称完整服务端合同；可能拒绝尚未验证的新响应形态。
- accepted 仅表示客户端获得支持的成功响应，不表示手机送达或已读。通知单 attempt、发送不重试、回执同 attempt 有界重试等持久化合同不变。

## 诊断

类型化异常仅保存固定原因：InvalidRet / RejectedRet / InvalidErrcode / RejectedErrcode / UnsupportedShape / InvalidMessageId / InvalidErrorMessage / UnconfirmedErrorMessage。日志带 `ILinkSend` 前缀，不插入响应字段、错误文本、message_id、chatId 或凭证。

HTTP 错误先按服务名前缀分类，微信 401/403 为 ILinkHttp401/403，不再被泛匹配误标为 ControllerAuth。Controller 自身 401/403 分类不变。非对象响应独立标为 ILinkInvalidResponse，语法错误沿用 InvalidJsonSyntax。

## 部署边界

只需更新 Gateway，无数据库迁移、Controller/Web/Daemon 更新、账号重新登录或新入站基线。不通过重建目标或重发旧通知验证修复；先用真实 CLI 与合成 HTTP/TLS、临时 PG 整链观察，再核对正式旧业务及 checkpoint 不变。回退代码不能改变已持久化通知状态。

## 后续改进建议

建议运维规范明确区分“空 JSON 对象”“空正文”“响应丢失”，并在执行 Compose 操作前核对当前子命令支持的参数。只建议，不修改全局规则或技能。
