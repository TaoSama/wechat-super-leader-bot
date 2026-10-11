# 控制面请求体边界

POST 现在要求单个合法 Content-Length、UTF-8 JSON 对象，拒绝 Transfer-Encoding；请求体上限 1 MiB、读取等待 10 秒。非法请求以 JSON 错误返回 400/413/408，不进入业务处理。/messages 在读请求体之前验证管理凭据。

验证：`.venv/bin/python -m pytest -q` 实测 99 passed；compileall、git diff --check 通过。新增 8 个真实本机回环 HTTP 测试覆盖畸形 JSON、非法长度、超限、非对象及未授权提前拒绝。临时测试服务均关闭。

证据边界：未验证公网代理、慢速持续上传或真实微信/模型任务；10 秒为 socket 读取超时，不是整个请求的严格墙钟截止时间。尚需逐字段类型校验、请求头超时和整体并发限制，不能据此宣称适合直接暴露公网。没有外部接口失败或重试。
