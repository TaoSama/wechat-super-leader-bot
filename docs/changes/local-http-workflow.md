# 本地 HTTP 跨模块闭环

新增真实回环 HTTP 集成测试：授权聊天绑定节点，普通文本通过 `/messages` 入队；NodeAgent 通过注册后的 token 领取任务、执行注入的成功/失败执行器，并通过 `/nodes/task-status` 回传；再通过 `/tasks` 查询终态。验证了未授权聊天、解绑、重复领取和失败结果。

验证：专项 2 passed；全量 `.venv/bin/python -m pytest -q` 实测 129 passed；compileall、git diff --check 通过。测试使用本机临时 HTTP 服务和假执行器，不调用 Codex、微信或远程网络。

证据边界：这是本机模块集成，不是 HTTPS、多机网络或真实模型验收；没有测试进程崩溃后的结果补报、TLS 代理和长期心跳。真实扫码仍未完成。
