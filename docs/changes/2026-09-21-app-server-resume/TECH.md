# 已有会话执行前恢复

官方来源（本轮已搜索并读取）：https://developers.openai.com/codex/app-server 。Lifecycle overview 与 API overview 规定 initialize 后先 start/resume thread，再 turn/start；thread/read 不加载会话。

send_turn 现在先 thread/resume 并核对返回 thread.id，失败或错配不发送 turn/start。turn/start 必须返回非空字符串 turn.id；turn/completed 只有 status=completed 才算成功，缺失或未知状态不再静默当成功。模块说明修正为独立 app-server，不宣称附着桌面运行中的 Task。

## 验证与证据边界

新增 13 个替身测试覆盖错误恢复结果、无效轮次 ID、未知/缺失/中断状态；已有成功测试验证 resume→start 顺序。实测 `.venv/bin/python -m pytest -q`：379 passed in 2.66s；compileall 与 git diff --check 通过。

没有调用真实 turn/start 或发送微信消息；方法调用序列与官方协议交叉核对，但不构成真实执行或桌面 UI 可见性验证。时间仅单次测试观测，无性能推算。官方搜索与文档读取无接口异常。

仍需处理 stdio 缓冲/超时、stderr 排空、请求期间通知丢失、并发串行化，以及桌面共享连接。approvalPolicy=never 保留原行为，本轮没有调整权限。用户目标尚未完成。

遵循 ai-scaffold-init 非空文件保护，不重建已有骨架；新变更文档按日期目录存放。回退只需恢复 send_turn 原流程与相应测试，无数据迁移。
