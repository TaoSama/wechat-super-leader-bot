# 微信登录区域地址恢复

登录确认响应可能返回区域专用 `baseurl`。transport 现在把该地址写入凭据，并在后续进程启动时恢复；显式的构造参数或 `WECHAT_ILINK_BASE_URL` 仍具有更高优先级，便于测试和运维覆盖。

验证：`tests/test_wechat.py` 10 passed；全量 `.venv/bin/python -m pytest -q` 412 passed；compileall 与 `git diff --check` 通过。

证据边界：使用本地合成凭据验证地址优先级，没有读取真实 token、扫码或发送微信消息；真实区域地址是否可用仍需扫码后由 iLink 返回值验证。
