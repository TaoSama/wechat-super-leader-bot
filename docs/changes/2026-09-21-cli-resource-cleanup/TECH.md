# CLI 资源收口

SuperLeader 新增幂等 `close()`，统一关闭 Codex WebSocket/stdio 客户端及 nodes/memory SQLite 连接。CLI 在创建 leader 后注册可用的 close 回调；控制面 finally 显式关闭，微信/演示/异常退出由 atexit 兜底。测试替身没有 close 时仍兼容，避免把测试替换对象的形状当作生产契约。重复 close 不会再次操作已关闭的 SQLite 连接。

## 验证与证据边界

新增关闭顺序测试；CLI 模式、服务清理和应用测试定向 40 passed。全量 `.venv/bin/python -m pytest -q`：399 passed in 12.52s；compileall、git diff --check 通过。临时目录运行 `--demo` 返回码 0 且创建数据库，TemporaryDirectory 自动清理；没有留下常驻进程。

这只保证当前 Python 进程正常释放句柄，不保证被 `SIGKILL`、机器断电或 SQLite 外部锁破坏时可恢复。微信凭据仍由 transport 自己管理，未读取或修改。扫码、真实微信轮询和 turn 仍需操作者显式启动。

回退删除 `close()`/atexit 变更即可，无数据格式迁移。
