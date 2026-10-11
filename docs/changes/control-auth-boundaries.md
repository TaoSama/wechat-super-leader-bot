# 控制面鉴权输入边界

非 ASCII Authorization 字符串不再进入 hmac.compare_digest(str,str) 引发 TypeError，统一拒绝；配置非 ASCII token 同样默认拒绝。显式传 auth_token="" 时禁用管理授权，不再意外继承 AUTH_TOKEN；仅 None 使用环境变量。

验证：`.venv/bin/python -m pytest -q` 实测 146 passed；compileall、git diff --check 通过。新增 8 个用例，包括真实本机 HTTP 非 ASCII 头返回 401，未触发业务处理。

证据边界：使用测试占位 token，未读取真实凭据、未改系统配置或发送外部消息。没有验证重复 Authorization 头、代理规范化或恒定时间性能；不代表完整安全审计。无外部接口失败或重试，当前无新增开发阻塞。
