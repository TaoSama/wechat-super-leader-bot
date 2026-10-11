# 微信凭据路径固定化

`ILinkWeChatTransport` 初始化时会把显式路径、`WECHAT_CREDENTIALS_PATH` 或默认路径展开并转为绝对路径；凭据与状态游标因此在进程切换工作目录后仍指向同一位置。

验证：新增 3 个路径回归测试；全量测试 437 passed，compileall 与 `git diff --check` 通过。未读取真实凭据。
