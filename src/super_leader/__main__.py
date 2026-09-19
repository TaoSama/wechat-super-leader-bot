from __future__ import annotations

import argparse
import time

from .app import SuperLeader
from .wechat import ILinkWeChatTransport


def main() -> None:
    parser = argparse.ArgumentParser(description="微信 Super Leader Agent")
    parser.add_argument("--demo", action="store_true", help="运行本地 mock 演示")
    parser.add_argument("--data-dir", default="data", help="运行数据目录")
    parser.add_argument("--wechat-login", action="store_true", help="获取微信 iLink 二维码并等待扫码")
    parser.add_argument("--wechat-poll-once", action="store_true", help="轮询一次微信消息并回复")
    parser.add_argument("--wechat-daemon", action="store_true", help="持续轮询微信并路由消息")
    parser.add_argument("--wechat-credentials", help="微信凭据文件路径")
    args = parser.parse_args()
    leader = SuperLeader(args.data_dir)
    if args.demo:
        for message in ("/help", "/sessions", "/nodes"):
            print(f"> {message}\n{leader.handle(message).text}\n")
    elif args.wechat_login or args.wechat_poll_once or args.wechat_daemon:
        transport = ILinkWeChatTransport(args.wechat_credentials)
        if args.wechat_login:
            account = transport.login()
            print(f"微信登录完成：{account['accountId']}")
        if args.wechat_poll_once or args.wechat_daemon:
            while True:
                for message in transport.poll():
                    result = leader.handle(message.text, message.chat_id)
                    transport.send(message.chat_id, result.text)
                if not args.wechat_daemon:
                    break
                time.sleep(1)
    else:
        print("Super Leader 已就绪。使用 --demo 运行本地演示。")


if __name__ == "__main__":
    main()
