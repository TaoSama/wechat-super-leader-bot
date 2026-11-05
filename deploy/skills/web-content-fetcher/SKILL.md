---
name: web-content-fetcher
description: 读取用户提供或搜索发现的已知网页 URL，提取公开页面的实际正文、标题和最终地址。适用于微信文章、新闻、博客和文档阅读；关键词搜索仍使用搜索工具。
---

# 网页正文读取

搜索摘要不代表已读取全文。

```bash
python3 /etc/codex/skills/web-content-fetcher/scripts/fetch_content.py 'https://example.com/article' --format markdown --timeout 30
```

参数见 `--help`。结果是 JSON，包含 `final_url`、`title`、`content`、`truncated`、`error` 等字段；需要保存时用 `--output` 写到可写的任务目录，不要写进技能目录。敏感请求头不写入聊天、脚本或日志。

- 退出码 `0` 表示获取和提取成功，仍要核对是不是目标正文；`1` 表示请求或提取失败；`2` 表示飞书云文档需要对应的授权 API，或参数有误。
- `truncated=true` 时内容被截断，不能说读完了全文。
- 不负责下载二进制文件。飞书 docx/wiki 等私人文档需要对应 API；没有可用的授权工具时如实说明，不把登录页当正文。

## 判断是否读到正文

核对最终 URL、标题和正文是否与请求相符。HTTP 200 或内容非空都不足以证明读到了目标文章，要排除验证码、登录页、只有导航的 JavaScript 壳和错误信息。短文章也是有效结果，不按长度判断失败。各站点的失败提示见 [公开文章与验证页](references/public-articles.md)。

## 无头环境边界

本环境通过 HTTP/API 获取内容，没有浏览器、Computer use 或本机登录态。遇到登录、微信环境验证、JavaScript 挑战或动态页面时，报告当前 URL、状态和失败证据；可以尝试同一内容的公开官方 API 或公开文本入口，但不反复请求同一挑战页、不绕过验证，也不请求安装桌面工具。没有取得目标正文时，不要生成声称来自该文章的总结。
