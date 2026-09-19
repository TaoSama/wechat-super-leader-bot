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

Codex 桌面 Task 通过本机 `codex app-server --stdio` 连接，不依赖 rollout 文件：微信里发送 `/threads` 查看桌面任务，发送 `/turn <thread_id> <任务>` 将任务投递到指定 Task；`/sessions` 仍保留为只读 rollout 目录兼容视图。

技能调用格式为 `/skill <技能名> <thread_id> <任务>`。技能目录从 `SKILL_ROOTS`、`~/.claude/skills`、`~/.codex/skills` 和 dotfiles 技能目录发现，Super Leader 的会话、节点、Leader 协调、进度和记忆技能作为内置路由提供。

可用 `ALLOWED_CHAT_IDS=id1,id2` 限制微信发送者。每次消息处理失败要记录 request id 并按 15 分钟周期重试，不能重复发送同一任务。微信消息应优先使用短段落、列表和链接，复杂 Markdown（表格、代码块、HTML）会降级为纯文本。

跨机控制面：

```bash
AUTH_TOKEN='随机长 token' python -m super_leader --serve --host 0.0.0.0 --port 8787
```

控制面提供 `/health`、`/messages`、`/nodes/register`、`/nodes/heartbeat` 和 `/nodes/dispatch`；生产环境应放在 Tailscale/内网或 HTTPS 反向代理后，不要直接暴露到公网。

公司机器上运行节点：

```bash
python -m super_leader --node-agent \
  --server-url https://你的控制面地址 \
  --node-name office-mac \
  --node-address office-mac \
  --node-auth-token '与控制面 AUTH_TOKEN 相同的长随机值'
```

节点会注册、发送心跳、拉取任务，并默认通过 `codex exec --fork-turns none` 执行任务；完成状态会回写控制面。

跨机节点不要暴露 Codex token：节点以一次性注册 token 加入，服务端只保存 token 哈希；节点心跳过期后禁止派发新任务。公网部署必须放在 HTTPS、反向代理和访问白名单之后。

如果 iLink 服务地址变化，可设置 `WECHAT_ILINK_BASE_URL`；不要把 bot token 写入仓库或 `.env.example`。
