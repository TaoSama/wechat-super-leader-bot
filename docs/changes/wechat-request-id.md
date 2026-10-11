# 微信失败 request id

微信 daemon 处理每条消息时记录其 message_id（缺失时使用 chat_id:unknown）；处理或回复异常日志会带 `request_id=...`，成功处理后重置为 idle。这样可把失败重试与具体消息关联，未改变错误退避和去重策略。

验证：`python -m super_leader --help` 正常；全量测试实测 87 passed，compileall、git diff --check 通过。未启动 daemon、未登录微信、未发送外部消息；日志格式未做真实终端采样。
