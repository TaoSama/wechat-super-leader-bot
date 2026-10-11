# Codex app-server turn 完成解析

## 变更

桌面 Task 客户端现在同时识别通知参数中的 `turnId` 和嵌套 `turn.id`，兼容真实完成事件形态。
只有收到匹配的 `turn/completed` 才返回结果；失败、取消、中断状态抛出错误，超时或连接流提前结束不会把部分输出当成成功。

## 验证

新增离线协议测试：嵌套 turn ID、失败完成、部分输出超时。全量命令 `.venv/bin/python -m pytest -q` 实测 52 passed。

## 证据边界

测试使用假的 JSONL 通知流，未连接真实桌面 Task；真实 app-server 的通知顺序、长连接断开和审批请求仍需实机验收。
本轮没有启动 Codex 任务、发送微信消息或修改系统配置。
