# app-server 客户端串行化

SuperLeader 复用单个 CodexAppServerClient，而 HTTP 服务采用线程模型。客户端新增实例级 RLock，覆盖启动、JSON-RPC 请求、完整 turn、关闭和缓存清理；共享连接上最多一个线程读写管道，避免两个微信请求交叉发送或消费对方的通知。使用可重入锁是因为 start/send_turn 会嵌套调用 request，非重入锁会自死锁。

## 验证与证据边界

新增共享客户端并发测试，两个线程同时发送 turn 时确认活动请求最大并发数为 1；与此前 5 个提前通知测试及全量套件共同验证。

实测 `.venv/bin/python -m pytest -q tests/test_codex_app_server.py`：18 passed in 0.13s；全量 pytest：392 passed in 2.84s；compileall 与 git diff --check 通过。并发测试使用替身，不调用真实 app-server、模型或微信；只证明本地锁的互斥性质，不证明跨进程或跨机器互斥。耗时为单次观测，无性能推算。

连接失步后的自动重连、跨进程连接池、结果 outbox、桌面 Task 附着仍未完成。本轮没有改变 approvalPolicy=never 或外部权限。回退只需移除 RLock 及并发测试，无持久数据迁移。
