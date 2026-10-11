# 微信查看 Codex Task 最近内容

新增 `/thread <thread_id>`：调用 app-server `thread/read(includeTurns=true)`，核对返回的 thread.id 后展示名称、工作目录、运行状态和最近一轮的用户/Codex 文本摘要；响应限制约 3500 字符并提示截断。该命令是只读，不调用 turn/start；与 `/threads` 列表、`/use` 绑定形成“发现—检查—持续发送”路径。

## 验证与证据边界

新增路由测试断言用户和 Codex 消息格式、结构化 data 和不发送行为。全量 `.venv/bin/python -m pytest -q`：398 passed in 16.77s；compileall、git diff --check 通过。测试中 `desktop.read_thread` 使用替身；此前真实本机 daemon 只读列表 smoke test 通过，本轮没有读取新外部 Task、执行 turn 或发送微信。

消息内容仅作摘要，未实现完整分页、跨页快照或聊天归属 ACL；Task ID 知道者仍可尝试读取。没有性能推算，耗时为单次观测。回退移除 helper、命令和文档，不改数据库。
