# Mac Mini 精确目标原 owner 复核

本地日期 2026-10-12；下列时间为 2026-10-11 UTC。本轮只读核查，不安装服务，不更改 App transport，不启动共享后端，不重启应用，不发送任务。

## 相互独立的身份与运行时证据

- 21:02–21:04：`ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=12 macmini` 成功；用户 macmini、UID 501、Mac16,10、arm64。
- `/Users/macmini/.codex/ipc/ipc.sock` 存在，socket 模式 `srw-------`（0600）、owner 501；lsof 映射当前 ChatGPT PID 1304，App 26.1007.30912。既有共享控制 socket 不存在；不能由此推导“必须更改桌面连接方式”。
- 21:05:36.211：仅受限读取持久化记录首行元数据，确认 `01a03f11-382b-7230-a517-0f7b3400e630` 与文件名一致，source=vscode，cwd=`/Users/macmini/Documents/ChatGPT/ordinary`。未读取正文或配置；此身份不证明 loaded/idle 或可控。

## 定点协议核查

通过 SSH 标准输入运行远端 `/Users/macmini/.local/bin/python3 -I -B -S -`，仅允许固定 socket 与上述精确 ID。脚本没有写入远端文件：

1. 连接既有 Unix socket，4 字节小端帧头；单帧硬上限 32 MiB，本次入站总预算另限 64 KiB。
2. `initialize` v0，校验 requestId、method、resultType 和 clientId/handledBy 一致。
3. `thread-owner-discovery` v1，仅指定 `hostId=local` 与精确 conversationId；等待总截止 8 秒、发现阶段最多 6 秒、噪声最多 128 帧。
4. 不订阅快照，不读模型设置，不 send/resume/list，不输出原 owner ID；关闭连接退出。

| 时间 UTC | 初始化 | owner discovery | 退出 |
| --- | --- | --- | --- |
| 21:06:03.177531 | 成功 | timeout / TimeoutError | 2 |
| 21:06:39.823047 | 成功 | 同一精确目标仅重试一次，仍 timeout | 2 |

两次都没有收到相关 response，不是明确的 `no-client-found`。因此只能说“本轮没有取得这个会话的 owner 证明”，不能说“Mini 上所有会话都没有 owner”，也不能仅由 timeout 判定持久会话不存在或整台机器离线。

## 结论与下一步

当前只能证明持久化身份及本机 IPC 可初始化，尚未证明该目标实时状态、历史读取和原进程发送。Air 同一适配路线的真实成功不能外推 Mini。已有 Mini 正式节点未安装/注册。

可由用户在 Mini 原 App 打开这个目标后再做定点复核，或提供明确允许验收的终端 pane；不主动打开、恢复、重建或改变会话宿主来绕过本轮限制。远端旧二进制未运行，未创建临时远端文件或后台进程，无需远端清理。
