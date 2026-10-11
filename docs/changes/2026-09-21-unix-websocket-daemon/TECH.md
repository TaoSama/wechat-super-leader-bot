# 本机 Codex daemon Unix-WebSocket 接入

只读诊断发现 `~/.codex/app-server-control/app-server-control.sock` 接受 WebSocket Upgrade，而不是裸 JSONL；之前使用 `codex app-server proxy` 也未产生响应。客户端现在对该 socket 直接执行 RFC 6455 客户端握手，发送 masked text frame，读取 text/binary frame，回复 ping，识别 close；JSON-RPC 仍使用原有协议。没有引入第三方依赖。

修正后本机实测通过：默认客户端连接当前 Codex 0.153.3 daemon，initialize 成功，`thread/list limit=1` 返回一条真实 Task（ID `0f81e739-3411-5901-b0ef-fafd69a3fb30`，只读列表，无 turn 执行）。测试保留 proxy/stdio 回退；socket 不可用时不会修改或重启 daemon。

## 验证与证据边界

新增真实本机 daemon WebSocket 列表 smoke test；app-server 定向测试 21 passed in 0.07s，全量 pytest **397 passed in 2.68s**；compileall、git diff --check 通过。真实验证范围仅 initialize/thread-list，未发送 turn、修改 Task、发送微信消息或测试跨机 TLS。测试输出中的 Task ID 来自当前本机 daemon 单次观测，不应作为稳定数据或权限证明。

此前 socket 直写 JSON 得到 EOF 的诊断输出和 HTTP 101 握手已交叉验证协议判断。daemon 日志存在历史模型刷新超时/线程 writer conflict，但本轮未触碰。WebSocket 长度/分片扩展、服务端 masked frame、连接失步自动恢复、远程认证和桌面 UI 可见性仍待验证。

回退仅恢复 stdio/proxy 命令路径并删除 WebSocket 代码和 smoke test；无数据库迁移、无用户进程停止。
