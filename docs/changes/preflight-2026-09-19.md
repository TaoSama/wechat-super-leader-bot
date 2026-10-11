# 运行前检查证据

本轮执行 `.venv/bin/python -m super_leader --check`：

- Codex CLI：PASS，路径 `/Users/luwentao/.local/bin/codex`
- Codex app-server：PASS，可读取，返回 1 条 Task
- 微信 iLink QR 接口：PASS，HTTP 200
- 数据目录：PASS
- 微信凭据：FAIL，`/Users/luwentao/.super-leader/wechat-account.json` 不存在

随后 `--help` 正常输出；全量测试实测 65 passed，compileall 和 git diff --check 通过。

凭据缺失是扫码联调前置条件，不是本地代码测试失败；本轮没有自动登录、发送消息或修改凭据文件。
