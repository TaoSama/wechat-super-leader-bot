# app-server 管道读取可靠性

stdout 改用非阻塞 os.read 与字节缓存分帧，先消费缓存中的完整行，再等待 selector。解决 TextIO.readline 预读第二行后 selector 看不到用户态缓存，以及半行数据让 readline 超过超时仍阻塞的问题。UTF-8 在完整行到达后解码，可接受跨读取拆分的中文字符。

stderr 加入同一 selector 并持续排空，内存仅保留最后 8192 字节，不打印日志正文。单帧限制 8 MiB，超限明确失败。重启清空缓冲，close 关闭三个流，避免描述符泄漏。该实现面向现有 macOS/POSIX 环境，未证明 Windows 管道兼容性。

## 验证与证据边界

7 个新测试使用真实 os.pipe 和一个自建 Python 子进程，覆盖连续帧、半帧超时后续传、多字节 UTF-8、非法 JSON/UTF-8/非对象、超大半帧、262144 字节 stderr 洪泛及流关闭。子进程是测试专用并由测试关闭；没有停止用户进程。

实测 `.venv/bin/python -m pytest -q tests/test_app_server_pipes.py`：7 passed in 0.04s。全量 pytest：386 passed in 2.69s；compileall 与 git diff --check 通过。超时测试仅验证 20 ms 配置下在 1 秒容差内返回，不构成精确时延基准；未进行性能推算。测试通道无异常，消息内容断言与进程/流关闭断言共同验证。

本轮是标准 Python 管道实现修复，不改协议或权限；遵循 go 技能验证闭环、ai-scaffold-init 既有非空文件保护。没有发送真实模型请求、微信消息，也没有验证桌面共享 Task 连接。请求等待期间通知丢失、并发访问、写入端背压和整个 turn 的总截止时间仍待处理。

回退只恢复原读取/启动/关闭路径并移除对应测试，无持久数据变化。
