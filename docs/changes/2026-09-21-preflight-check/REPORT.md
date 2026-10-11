# 扫码前环境检查

运行命令：

```text
.venv/bin/python -m super_leader --check --data-dir /tmp/wechat-super-leader-check
```

实测结果：

- PASS：Codex CLI，路径 `/Users/luwentao/.local/bin/codex`
- PASS：Codex app-server，可读取 1 条真实本机 Task
- PASS：微信 iLink QR 接口，HTTP 200
- PASS：数据目录可写，`/private/tmp/wechat-super-leader-check`
- FAIL：微信凭据不存在：`/Users/luwentao/.super-leader/wechat-account.json`

这是预期的扫码前状态，不读取或生成凭据。明早扫码命令：

```bash
cd /Users/luwentao/Documents/ordinary/wechat-super-leader-bot
ALLOWED_CHAT_IDS='扫码后实际发送者ID' .venv/bin/python -m super_leader \
  --wechat-login --wechat-credentials "$HOME/.super-leader/wechat-account.json"
ALLOWED_CHAT_IDS='扫码后实际发送者ID' .venv/bin/python -m super_leader \
  --wechat-daemon --data-dir ./data \
  --wechat-credentials "$HOME/.super-leader/wechat-account.json"
```

首次测试若还不知道发送者 ID，可临时启动一次 `--wechat-daemon`（不退出、不需要猜 ID），在微信发送 `/help`；终端会打印 `收到微信消息 chat_id=...`。停止进程，把该值填入 `ALLOWED_CHAT_IDS` 后再启动。未授权消息仍会收到“未被授权”回复，不会执行任务；不要把日志或 ID 发到公开渠道。

## 证据边界

检查只调用 QR GET、Codex `thread/list` 和临时目录写探针；没有扫码、保存 token、发送微信消息或启动长期 daemon。HTTP 200 只证明 QR 接口可达，不证明账号登录或主动回复权限。凭据缺失是当前唯一 FAIL，也是扫码前应有状态。无性能推算；结果为单次本机观测。
