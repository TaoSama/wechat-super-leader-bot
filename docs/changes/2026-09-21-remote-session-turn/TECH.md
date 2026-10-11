# 跨机已有 Codex 会话轮次调度 (remote-session-turn)

在远程节点任务执行器中引入结构化受控 JSON envelope，支持向已有 Codex 会话追加轮次（turn）：
```json
{"kind": "session_turn", "session_id": "<session_id>", "prompt": "<prompt>"}
```

## Envelope 格式与安全校验

1. 格式识别与解析：当任务 payload 为 JSON 且包含 `kind` 字段时进入受控 envelope 分支；普通纯文本任务仍保持既有回退调用 `self.sessions.fork(payload)` 创建独立子会话。
2. 严格字段校验：对 `session_turn` 类型严格校验 `session_id` 与 `prompt` 必须存在且均为非空字符串。若缺少必须字段、类型不符或 JSON 结构异常，任务立即标记为失败并记录错误信息，绝对不降级或静默调用任一执行路径。
3. 隔离调用：校验通过后显式调用 `self.sessions.send(session_id, prompt)`，并将标准输出/错误标准化返回。

## 验证与证据边界

本变更已在本地通过定向单元测试与模拟执行器验证（包括 envelope 校验失败拒绝、成功路由至 `sessions.send` 以及纯文本保持 `sessions.fork`）。

当前工作区全量验证：`.venv/bin/python -m pytest -q` 实测 411 passed；`compileall` 与 `git diff --check` 通过。

需要明确的是，当前仅完成了本地数据结构解析与执行分支的受控实现，尚未在真实的跨机 HTTPS 节点网络环境、真实多机网络延迟与证书链路下进行端到端联调验证。
