# Super Leader Agent 测试计划

## 1. 自动化门槛

在项目根目录执行：

```bash
source .venv/bin/activate
python -m compileall -q src
python -m pytest -q
```

扫码前先运行 `python -m super_leader --check`，它只做环境检查，不登录、不发消息。

通过条件：测试全部通过；当前覆盖微信 Markdown 降级、Mock 登录生命周期、记忆、Skill 路由、Codex session 发现、Codex app-server Task 列表、节点鉴权、任务派发/回传和控制面 HTTP 接口。

## 2. 明早微信扫码验收

```bash
python -m super_leader --wechat-login
python -m super_leader --wechat-daemon
```

依次发送：

```text
/help
/remember 明天验证跨机任务
/recall 跨机
/threads
```

通过条件：二维码能打开、扫码确认后凭据写入用户目录且权限为 `0600`；每条命令都有回复；进程重启后仍能继续轮询。

## 3. Codex 桌面 Task 验收

1. `/threads` 能列出当前桌面 Task。
2. 选择一个无破坏性的 Task，发送 `/turn <thread_id> 请只回复 READY，不修改文件`。
3. 在 Codex 桌面端确认该 Task 收到新 turn，并检查微信收到回复。

## 4. 跨机节点验收

控制面机器：

```bash
AUTH_TOKEN='随机长 token' python -m super_leader --serve --host 0.0.0.0 --port 8787
```

节点机器：

```bash
python -m super_leader --node-agent \
  --server-url http://控制面地址:8787 \
  --node-name office-mac \
  --node-address office-mac \
  --node-auth-token '随机长 token'
```

微信侧验收：

```text
/nodes
/remote-sessions
/dispatch office-mac 只读取系统版本并返回，不修改文件
/tasks
```

通过条件：节点状态在线；远程 session 清单出现；任务经历 queued、running、completed/failed；结果能在 `/tasks` 中看到。

## 5. 失败处理

- 二维码过期：重新执行 `--wechat-login`，不要手工编辑 token。
- `getupdates` 超时：daemon 自动退避重试；连续失败时检查网络和 `WECHAT_ILINK_BASE_URL`。
- Codex Task 不可用：先执行 `codex app-server --stdio` 的本地 smoke test，再检查项目是否被 Codex 信任。
- 节点离线：停止派发，检查控制面 HTTPS/Tailscale、`AUTH_TOKEN` 和节点心跳；不会自动执行补偿任务。
