# Codex 会话 ID 参数校验

`CodexSessionManager.send` 现在拒绝空值、CLI 选项样式（以 `-` 开头）、空白字符和控制字符，避免来自微信或远程节点的会话 ID 被误解释为命令选项或破坏参数边界。

验证：新增 11 个拒绝执行器调用的测试；全量测试 426 passed，compileall 与 `git diff --check` 通过。未启动真实 Codex turn。
