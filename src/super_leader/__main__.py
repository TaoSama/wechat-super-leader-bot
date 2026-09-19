from __future__ import annotations

import argparse
import time

from .app import SuperLeader
from .server import serve
from .node_agent import NodeAgent
from .doctor import run_check
from .wechat import ILinkWeChatTransport


def main() -> None:
    parser = argparse.ArgumentParser(description="微信 Super Leader Agent")
    parser.add_argument("--demo", action="store_true", help="运行本地 mock 演示")
    parser.add_argument("--data-dir", default="data", help="运行数据目录")
    parser.add_argument("--wechat-login", action="store_true", help="获取微信 iLink 二维码并等待扫码")
    parser.add_argument("--wechat-poll-once", action="store_true", help="轮询一次微信消息并回复")
    parser.add_argument("--wechat-daemon", action="store_true", help="持续轮询微信并路由消息")
    parser.add_argument("--wechat-credentials", help="微信凭据文件路径")
    parser.add_argument("--serve", action="store_true", help="启动内网控制面 HTTP 服务")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--node-agent", action="store_true", help="以远程节点身份注册并拉取任务")
    parser.add_argument("--server-url", default="http://127.0.0.1:8787")
    parser.add_argument("--node-name")
    parser.add_argument("--node-address", default="127.0.0.1")
    parser.add_argument("--node-auth-token")
    parser.add_argument("--check", action="store_true", help="检查运行环境，不登录、不发送消息")
    args = parser.parse_args()
    leader = SuperLeader(args.data_dir)
    if args.check:
        for name, ok, detail in run_check(args.data_dir):
            print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}")
        return
    if args.demo:
        for message in ("/help", "/sessions", "/nodes"):
            print(f"> {message}\n{leader.handle(message).text}\n")
    elif args.node_agent:
        if not args.node_name or not args.node_auth_token:
            parser.error("--node-agent requires --node-name and --node-auth-token")
        def execute(payload: str) -> str:
            result = leader.sessions.fork(payload)
            return (result.stdout or result.stderr or "Codex accepted task").strip()
        NodeAgent(args.server_url, args.node_name, args.node_address, args.node_auth_token, execute).run()
    elif args.serve:
        server = serve(leader, args.host, args.port)
        print(f"控制面已启动：http://{args.host}:{args.port}")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            server.shutdown()
    elif args.wechat_login or args.wechat_poll_once or args.wechat_daemon:
        transport = ILinkWeChatTransport(args.wechat_credentials)
        if args.wechat_login:
            account = transport.login()
            print(f"微信登录完成：{account['accountId']}")
        if args.wechat_poll_once or args.wechat_daemon:
            retry_delay = 1.0
            while True:
                try:
                    for message in transport.poll():
                        result = leader.handle(message.text, message.chat_id)
                        transport.send(message.chat_id, result.text)
                    retry_delay = 1.0
                except Exception as error:
                    print(f"微信轮询/回复失败：{error}")
                    if not args.wechat_daemon:
                        raise
                    time.sleep(retry_delay)
                    retry_delay = min(retry_delay * 2, 60.0)
                if not args.wechat_daemon:
                    break
                time.sleep(1)
    else:
        print("Super Leader 已就绪。使用 --demo 运行本地演示。")


if __name__ == "__main__":
    main()
