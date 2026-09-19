## 明早扫码测试

当前版本已内置微信 iLink transport：二维码登录、长轮询收消息、上下文 token 回复和 Markdown 降级；同时保留 `mock` transport 做离线测试。

```bash
cd /Users/developer/Documents/ordinary/wechat-super-leader-bot
cp .env.example .env
python3 -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
python -m pytest -q
python -m super_leader --demo
```

明早扫码测试：

```bash
python -m super_leader --wechat-login
python -m super_leader --wechat-daemon
```

第一条命令会打印短时有效的微信登录 URL，扫码并在手机确认；凭据默认保存到 `~/.super-leader/wechat-account.json`（权限 `0600`）。第二条命令启动长轮询，把收到的消息交给 Super Leader，再通过 `ilink/bot/sendmessage` 回复。首次收到某个聊天的消息后才有该聊天的 context token，主动推送需要先建立过会话。

可用 `ALLOWED_CHAT_IDS=id1,id2` 限制微信发送者。每次消息处理失败要记录 request id 并按 15 分钟周期重试，不能重复发送同一任务。微信消息应优先使用短段落、列表和链接，复杂 Markdown（表格、代码块、HTML）会降级为纯文本。

跨机控制面：

```bash
AUTH_TOKEN='随机长 token' python -m super_leader --serve --host 0.0.0.0 --port 8787
```

控制面提供 `/health`、`/messages`、`/nodes/register`、`/nodes/heartbeat` 和 `/nodes/dispatch`；生产环境应放在 Tailscale/内网或 HTTPS 反向代理后，不要直接暴露到公网。

跨机节点不要暴露 Codex token：节点以一次性注册 token 加入，服务端只保存 token 哈希；节点心跳过期后禁止派发新任务。公网部署必须放在 HTTPS、反向代理和访问白名单之后。

如果 iLink 服务地址变化，可设置 `WECHAT_ILINK_BASE_URL`；不要把 bot token 写入仓库或 `.env.example`。
