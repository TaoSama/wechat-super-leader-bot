# 运行手册

当前只有 TypeScript Controller/Gateway、Go Daemon、React Web 一套实现；旧 Python、slash 命令和独立 worker 的操作方式均已删除。

正式实例入口、Mac/Linux 原生服务及微信允许名单见 [远端运维说明](hong-kong.md)。运行前先检查 `node local.mjs --check --controller https://leader.example.com`；无节点时检查原生 Daemon，不启动独立 app-server 替代原会话。独立本机开发环境另见 [项目说明](../../README.md)。

## 微信人工联调

1. 先完成模拟测试，不启动真实 Gateway，不使用真实微信 token。
2. 用户准备好后，核对已扫码账号及实际发送者 chatId，只授权该 chatId。不要根据消息正文自动认领身份。
3. 按远端手册授权 Controller 的 `ALLOWED_CHAT_IDS`，通过独立 Docker Gateway 接入。本地允许名单维持为空，不启动第二个 Controller 或第二个微信轮询进程。
4. 首次上线先 `--establish-baseline` 跳过历史，再启动 `wechat` profile；收到就绪通知后，由用户亲自发送下方测试消息。正常重启不重建基线、不删除 checkpoint。
5. 在 Codex App 打开专用测试会话并确认它可发送，再发：“查看 demoair 上的测试会话”；“让 Super Leader demoair 联调会话 这个会话只回复 WECHAT_OK，不调用工具、不修改文件”。
6. 核对计划目标后发送“确认执行”；随后问“刚才那个任务完成了吗，原文是什么”。
7. 必须核对精确 turnId、completed 和 WECHAT_OK；accepted 不算验收通过。

发送者必须由真实入站与已登录账号身份核实，不能按消息正文认领。不能把保存 token、一次发送 HTTP 200 或健康空轮询当作微信端到端成功。若凭证过期，需另外完成重新登录；不要手改 token。

## 持久化和部署

- PostgreSQL volume、`.runtime/daemon-state` 和微信账号凭证必须保留。Docker down 不加 `-v`。
- Daemon journal 独占锁防止重复实例；不可删除 journal 来绕过锁。
- 断线或重启后仅查询原 turn，不重新发送。uncertain 先核验，不能当失败随意重跑。
- 跨机入口已部署为 `https://leader.example.com`，Daemon 使用 WSS，每节点独立 token；本机 127.0.0.1 不是远程可访问地址。
- 用户服务仅在显式 `--service install` 时安装；不修改隧道、防火墙或 linger，不停止其他项目进程。

详细协议与边界见 [验收清单](../changes/2026-10-10-control-plane/ACCEPTANCE.md)。
