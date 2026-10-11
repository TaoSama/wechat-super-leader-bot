# 派发归属失败时 fail-closed

移除 `_enqueue` 对 `owner_chat_id` 的兼容性回退。节点注册表不支持聊天归属参数或处理该参数抛错时，调用立即失败，不再重试无归属派发，避免任务泄露给其他聊天。

验证：并发派发、参数转发和异常不重试测试通过；全量测试 463 passed，compileall 与 `git diff --check` 通过。
