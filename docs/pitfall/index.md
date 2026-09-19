## 已知限制

- 微信客户端对 Markdown 支持不完整，发送层必须做降级。
- Codex 子代理调用默认使用 `fork_turns=none`，避免继承无关上下文；Gemini 等自定义 provider 仍需验证 inter-agent payload 兼容性。
- 本地会话发现是只读的；真正的跨机执行必须由已注册节点主动拉取任务。
