## 明早扫码测试

当前版本先用 `mock` transport 验证 Super Leader 的路由、记忆和 Codex 会话发现；真实微信 transport 需要将 `WECHAT_BACKEND` 切换为项目接入适配器并配置登录凭据。

```bash
cd /Users/luwentao/Documents/ordinary/wechat-super-leader-bot
cp .env.example .env
python3 -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
python -m pytest -q
python -m super_leader --demo
```

接入真实微信时，先启动服务并保留二维码路径，再扫码确认账号；每次消息处理失败要记录 request id 并按 15 分钟周期重试，不能重复发送同一任务。微信消息应优先使用短段落、列表和链接，复杂 Markdown（表格、代码块、HTML）需要降级为纯文本。

跨机节点不要暴露 Codex token：节点以一次性注册 token 加入，服务端只保存 token 哈希；节点心跳过期后禁止派发新任务。公网部署必须放在 HTTPS、反向代理和访问白名单之后。
