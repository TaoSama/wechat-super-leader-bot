# 普通派发与会话续接 envelope 隔离

聊天入口的 `/remote-turn` 使用 `kind=session_turn` 触发 `sessions.send`。普通 `/dispatch` 和绑定节点的自然语言若正文看起来像保留 JSON，则包装为 `kind=fresh_task` 并仍调用 `sessions.fork`，避免用户正文意外续接已有会话。管理 HTTP 派发接口仍接受原始控制 envelope；此改动不是对管理接口的权限限制。控制面与节点应配套升级，旧节点不支持 `fresh_task` 时会拒绝该任务。

验证：新增普通 JSON 正文路由与节点 fork 测试；全量测试 478 passed，compileall 与 `git diff --check` 通过。未启动真实模型或远程节点。
