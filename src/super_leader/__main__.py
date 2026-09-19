from __future__ import annotations

import argparse

from .app import SuperLeader


def main() -> None:
    parser = argparse.ArgumentParser(description="微信 Super Leader Agent")
    parser.add_argument("--demo", action="store_true", help="运行本地 mock 演示")
    parser.add_argument("--data-dir", default="data", help="运行数据目录")
    args = parser.parse_args()
    leader = SuperLeader(args.data_dir)
    if args.demo:
        for message in ("/help", "/sessions", "/nodes"):
            print(f"> {message}\n{leader.handle(message).text}\n")
    else:
        print("Super Leader 已就绪。使用 --demo 运行本地演示。")


if __name__ == "__main__":
    main()

