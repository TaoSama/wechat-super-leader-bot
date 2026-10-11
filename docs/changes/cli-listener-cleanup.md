# 控制面退出释放监听端口

CLI --serve 在 finally 调用 server_close，覆盖正常返回、KeyboardInterrupt 和异常。serve_forever 已在当前线程退出后不再调用用于其它线程通知退出的 shutdown。Ctrl+C 显示停止提示，非中断异常继续向上传播。启动提示使用实际 server_port，使 --port 0 的随机端口可见。

按开发技能保持最小服务生命周期修复，不结束用户进程或修改监听配置。

## 验证与证据边界

新增 3 个测试，对真实本机回环监听 socket 注入正常返回/中断/异常，验证描述符关闭且相同地址可再次 bind；CLI 输出包含实际端口。实测 pytest：335 passed in 2.58s；compileall 和 git diff --check 通过。

serve_forever 由替身触发退出，未发送真实 OS 信号、未测试活跃请求排空或真实模型任务中断。描述符与端口重绑定交叉验证，无时间/性能推算，无外部接口异常。测试 socket 均关闭，无常驻服务。数据库及其它 CLI 分支整体资源清理仍未统一；结果持久化补报仍待完成。回退仅恢复原 --serve 分支清理与输出。
