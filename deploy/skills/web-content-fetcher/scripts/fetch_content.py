#!/usr/bin/env python3
"""Fetch public HTTP pages and extract bounded text, Markdown or HTML as JSON."""

import argparse
import json
import math
import re
import resource
import subprocess
import sys
import tempfile
from email.message import Message
from pathlib import Path
from urllib.parse import urlsplit

MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_CONTENT_CHARS = 50_000
MAX_HTML_TAGS = 50_000
MAX_URL_CHARS = 8192
MAX_TIMEOUT_SECONDS = 120
DEFAULT_TIMEOUT_SECONDS = 30
MAX_REDIRECTS = 5
CURL_GRACE_SECONDS = 2
DEFAULT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
TEXT_MIME_TYPES = {
    "application/json", "application/xml", "application/xhtml+xml",
    "application/rss+xml", "application/atom+xml", "application/javascript",
}
SITE_SELECTORS = {
    "mp.weixin.qq.com": ["div#js_content", "div.rich_media_content"],
    "zhuanlan.zhihu.com": [".Post-RichText"],
    "zhihu.com": [".Post-RichText", ".RichContent-inner"],
    "blog.csdn.net": ["#article_content", ".article-content-body"],
    "juejin.cn": [".article-area", ".article-content"],
    "36kr.com": [".article-detail", ".article-content"],
    "infoq.cn": [".article-holder", ".article-content"],
    "163.com": [".post_body", ".article-body"],
    "toutiao.com": [".ssa-article", ".article-content"],
    "sspai.com": [".article-body", ".post-content"],
    "github.com": [".markdown-body"],
}
GENERIC_SELECTORS = [
    "article", "main", '[role="main"]', '[role="article"]',
    '[itemprop="articleBody"]', ".post-content", ".article-content",
    ".entry-content", ".article-body", ".article-detail", ".article-holder",
    ".post_body", ".markdown-body", "#content",
]
BLOCKED_TITLES = {
    "just a moment", "please wait", "access denied", "sign in", "login",
    "登录", "安全验证", "环境异常", "微信公众平台验证",
}


class FetchError(Exception):
    """An actionable retrieval or extraction failure."""


def validate_url(url):
    try:
        parsed = urlsplit(url)
        if (len(url) > MAX_URL_CHARS or parsed.scheme not in {"http", "https"}
                or not parsed.hostname or parsed.username or parsed.password
                or any(ord(char) < 33 or ord(char) == 127 for char in url)):
            raise ValueError("invalid URL")
        _ = parsed.port
        return parsed
    except ValueError as exc:
        raise FetchError("URL 必须是有效的 HTTP/HTTPS 地址，且不含内嵌凭证或空白") from exc


def is_feishu_url(parsed):
    host = parsed.hostname.lower()
    domains = ("feishu.cn", "larkoffice.com", "larksuite.com")
    return (any(host == domain or host.endswith("." + domain) for domain in domains)
            and any(part in parsed.path for part in ("/docx/", "/wiki/", "/sheets/", "/base/", "/mindnotes/")))


def limit_file_size():
    # The OS also bounds chunked bodies on curl versions without streaming size checks.
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_RESPONSE_BYTES + 1, MAX_RESPONSE_BYTES + 1))


def curl_fetch(url, timeout, headers):
    for header in headers:
        name, separator, value = header.partition(":")
        if not separator or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name) or any(
            ord(char) < 32 or ord(char) == 127 for char in value
        ):
            raise FetchError("请求头必须是单行 K:V")
    with tempfile.TemporaryDirectory(prefix="web-content-fetcher-") as directory:
        body_file = Path(directory) / "body"
        command = [
            "curl", "-q", "--globoff", "--silent", "--show-error", "--location",
            "--proto", "=http,https", "--proto-redir", "=http,https",
            "--max-time", str(timeout), "--max-redirs", str(MAX_REDIRECTS),
            "--max-filesize", str(MAX_RESPONSE_BYTES), "--output", str(body_file),
            "--write-out", "%{http_code}\t%{url_effective}\t%{content_type}",
            "--user-agent", DEFAULT_USER_AGENT,
            "--header", "Accept: text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
            "--header", "Accept-Language: zh-CN,zh;q=0.9,en;q=0.8",
        ]
        for header in headers:
            command.extend(["--header", header])
        command.extend(["--url", url])
        try:
            process = subprocess.run(command, capture_output=True, timeout=timeout + CURL_GRACE_SECONDS,
                                     preexec_fn=limit_file_size)
        except subprocess.TimeoutExpired as exc:
            raise FetchError(f"请求超时 ({timeout:g}s)") from exc
        except OSError as exc:
            raise FetchError(f"无法执行 curl: {exc.strerror}") from exc
        metadata = process.stdout.decode("utf-8", errors="replace").split("\t", 2)
        status = int(metadata[0]) if metadata[0].isdigit() else 0
        final_url = metadata[1] if len(metadata) > 1 else url
        content_type = metadata[2] if len(metadata) > 2 else ""
        size = body_file.stat().st_size if body_file.exists() else 0
        error = None
        if size > MAX_RESPONSE_BYTES or process.returncode == 63:
            error = f"响应超过 {MAX_RESPONSE_BYTES} 字节上限"
        elif process.returncode == 28:
            error = f"请求超时 ({timeout:g}s)"
        elif process.returncode:
            error = f"curl 请求失败 (exit {process.returncode})"
        elif not 200 <= status < 300:
            error = f"HTTP {status}" if status else "未收到有效 HTTP 状态"
        elif not size:
            error = "响应正文为空"
        body = body_file.read_bytes() if not error else b""
        return body, status, final_url, content_type.strip(), error


def decode_body(body, content_type):
    message = Message()
    message["content-type"] = content_type
    charset = message.get_content_charset()
    if charset:
        try:
            return body.decode(charset), message.get_content_type()
        except (LookupError, UnicodeDecodeError) as exc:
            raise FetchError("响应正文与声明的字符编码不符") from exc
    # HTML often declares its encoding in a meta tag, including older Chinese pages.
    from bs4 import UnicodeDammit
    detected = UnicodeDammit(body, is_html=True)
    if detected.unicode_markup is None:
        raise FetchError("无法识别响应正文字符编码")
    return detected.unicode_markup, message.get_content_type() if content_type else ""


def extract_html(html, url, output_format):
    from bs4 import BeautifulSoup
    if html.count("<") > MAX_HTML_TAGS:
        raise FetchError("HTML 结构过于复杂，超过解析上限")
    soup = BeautifulSoup(html, "html.parser")
    title = soup.title.get_text(" ", strip=True) if soup.title else ""
    host = urlsplit(url).hostname.lower()
    wechat_body = soup.select_one("#js_content, .rich_media_content") if host == "mp.weixin.qq.com" else None
    has_wechat_body = wechat_body is not None and bool(wechat_body.get_text(strip=True))
    if has_wechat_body:
        heading = soup.select_one("#activity-name")
        if heading is not None and heading.get_text(strip=True):
            title = heading.get_text(" ", strip=True)
    if not has_wechat_body and title.casefold().strip(" .…!") in BLOCKED_TITLES:
        raise FetchError(f"页面要求登录或验证，未取得目标正文（{title}）")
    if not has_wechat_body and soup.select_one("#js_verify, #verify_container") is not None:
        raise FetchError("页面要求环境验证，未取得目标正文")
    if host == "mp.weixin.qq.com" and not has_wechat_body:
        page_text = soup.get_text(" ", strip=True)
        if any(marker in page_text for marker in (
            "当前环境异常，完成验证后即可继续访问", "访问过于频繁，请稍后再试",
            "请在微信客户端打开链接", "该内容已被发布者删除", "该内容已被投诉",
        )):
            raise FetchError("微信页面要求环境验证或文章不可用，未取得目标正文")
        raise FetchError("微信页面缺少文章正文，未取得目标正文")
    for tag in soup.find_all(["script", "style", "noscript", "iframe", "svg", "nav", "footer"]):
        tag.decompose()
    selectors = []
    for domain, candidates in SITE_SELECTORS.items():
        if host == domain or host.endswith("." + domain):
            selectors.extend(candidates)
            break
    selected = None
    for selector in selectors + GENERIC_SELECTORS:
        found = soup.select_one(selector)
        if found is not None and found.get_text(strip=True):
            selected = found
            break
    selected = selected if selected is not None else (soup.body or soup)
    plain = selected.get_text(separator="\n", strip=True)
    if not plain:
        raise FetchError("未提取到可读正文；页面可能需要 JavaScript 或登录")
    if output_format == "html":
        return title, html, "html", "curl_raw"
    if output_format == "text":
        return title, plain, "text", "curl+readability"
    import html2text
    for image in selected.find_all("img"):
        if image.get("data-src"):
            image["src"] = image["data-src"]
            del image["data-src"]
    converter = html2text.HTML2Text()
    converter.body_width = 0
    converter.ignore_links = False
    converter.ignore_images = False
    converter.ignore_emphasis = False
    converter.skip_internal_links = True
    content = re.sub(r"\n{3,}", "\n\n", converter.handle(str(selected))).strip()
    if not content:
        raise FetchError("Markdown 转换后正文为空")
    return title, content, "markdown", "curl+readability"


def fetch(args):
    result = {"url": args.url, "final_url": args.url, "title": "", "content": "",
              "format": args.format, "method": "curl_failed", "status_code": 0,
              "content_type": "", "truncated": False, "error": None}
    try:
        parsed = validate_url(args.url)
        if is_feishu_url(parsed):
            result["method"] = "feishu_redirect"
            raise FetchError("飞书云文档需要对应 API 授权；此 HTTP 技能无法读取登录态")
        body, status, final_url, content_type, error = curl_fetch(args.url, args.timeout, args.headers or [])
        result.update(status_code=status, final_url=final_url, content_type=content_type)
        if error:
            raise FetchError(error)
        validate_url(final_url)
        mime = content_type.partition(";")[0].strip().lower()
        if mime and not (mime.startswith("text/") or mime in TEXT_MIME_TYPES or mime.endswith("+json") or mime.endswith("+xml")):
            raise FetchError(f"不支持的正文类型: {mime}；此技能不负责文件下载")
        decoded, mime = decode_body(body, content_type)
        is_html = "html" in mime or (not mime and re.match(r"\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b)", decoded, re.I))
        if is_html:
            title, content, fmt, method = extract_html(decoded, final_url, args.format)
        else:
            title, content, fmt, method = "", decoded.strip(), "text", "curl_raw"
        if not content:
            raise FetchError("未提取到可读正文")
        result.update(title=title, content=content[:MAX_CONTENT_CHARS], format=fmt,
                      method=method, truncated=len(content) > MAX_CONTENT_CHARS)
    except (FetchError, ImportError) as exc:
        result["error"] = str(exc)
    except OSError as exc:
        result["error"] = f"读取响应失败: {exc.strerror}"
    return result


def timeout_value(value):
    number = float(value)
    if not math.isfinite(number) or not 0 < number <= MAX_TIMEOUT_SECONDS:
        raise argparse.ArgumentTypeError(f"timeout 必须大于 0 且不超过 {MAX_TIMEOUT_SECONDS} 秒")
    return number


def main():
    parser = argparse.ArgumentParser(description="提取公开 HTTP/HTTPS 网页正文，输出 JSON")
    parser.add_argument("url", help="目标 URL")
    parser.add_argument("--format", choices=["text", "markdown", "html"], default="markdown")
    parser.add_argument("--timeout", type=timeout_value, default=DEFAULT_TIMEOUT_SECONDS, help="请求总超时秒数，最多 120")
    parser.add_argument("--output", "-o", help="将完整 JSON 结果写入文件")
    parser.add_argument("--headers", "-H", action="append", help="自定义单行请求头 K:V；不要写入聊天或日志")
    args = parser.parse_args()
    result = fetch(args)
    output = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        try:
            Path(args.output).write_text(output + "\n", encoding="utf-8")
        except OSError as exc:
            print(f"保存结果失败: {exc.strerror}", file=sys.stderr)
            return 1
    else:
        print(output)
    return 2 if result["method"] == "feishu_redirect" else int(result["error"] is not None)


if __name__ == "__main__":
    sys.exit(main())
