# 启动确认前的轮次通知

turn/start 请求等待响应时保留 agentMessage/delta 与 turn/completed，返回 turn.id 后先消费缓存再读取管道。设置 1024 条及 8 MiB 序列化字节容量，溢出明确失败，不静默截断。消费时按 turn.id 过滤，若有 threadId 也必须匹配；每次新启动前及 close 清空缓存。

同时区分服务器请求与客户端响应：带 method 和 id 的消息先处理服务器请求，避免审批请求恰好使用相同数字 id 时被误当 turn/start 确认。审批仍按既有逻辑拒绝，没有扩大权限。

## 验证与证据边界

新增 5 个真实 Python 子进程/stdio 测试，伪服务完成 initialize、resume、start，并在 start 响应前发出同 ID 审批、错误 thread/turn 的文本、中文正文和终态。验证重复调用不带入旧结果，失败/中断不误报成功，两种容量超限明确失败且 close 清理缓存。子进程是测试创建的替身，测试后关闭；未调用真实模型或微信。

实测定向 pytest：5 passed in 0.07s；全量 `.venv/bin/python -m pytest -q`：391 passed in 2.76s。compileall、git diff --check 通过。耗时仅单次观测，无性能推算。测试通道未发生异常；返回文本与审批响应/异常类型交叉核对。

此变更按 go 技能完成验证闭环，按 ai-scaffold-init 保留已有骨架。不声称共享桌面运行中 Task 已接通。并发串行化、连接失步后恢复、未知服务器请求响应、写入背压及跨机结果持久化仍待完成。容量超限或超时后不要自动重发 turn/start，因为原请求可能已经执行。

回退仅恢复消息分发代码及移除新测试，不涉及数据迁移。
