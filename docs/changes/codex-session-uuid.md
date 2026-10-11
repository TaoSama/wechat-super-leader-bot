# Codex rollout 会话 ID

`/sessions` 现在从每个 rollout JSONL 的首个 `session_meta.payload.id/session_id` 读取 Codex canonical UUID；只有元数据损坏时才回退文件 stem，并额外保留 `file_id` 供诊断。这样 `/codex <session_id>` 使用的是 `codex exec resume` 可识别的会话 ID，而不是 rollout 文件名。

验证：全量 `.venv/bin/python -m pytest -q` 实测 91 passed；新增 canonical UUID 测试，demo/help、compileall 和 git diff --check 通过。

证据边界：未对每个历史 rollout 做完整 JSONL 校验；损坏首行会回退，后续 resume 仍可能失败。未发送微信消息或执行真实 resume 任务；真实模型写入链路仍需单独验收。
