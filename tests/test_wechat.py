from super_leader.wechat import MockWechatTransport, ScanStatus, WechatAdapter, markdown_to_wechat


def test_markdown_to_wechat_keeps_content_and_removes_markup():
    source = "# 标题\n\n**重点** 与 `代码`\n- 一项\n[文档](https://example.com)"
    assert markdown_to_wechat(source) == "标题\n\n重点 与 代码\n• 一项\n文档 (https://example.com)"


def test_mock_transport_scan_lifecycle_and_messages(tmp_path):
    transport = MockWechatTransport(tmp_path / "login.png")
    assert transport.scan_status is ScanStatus.IDLE
    assert transport.start_login().status is ScanStatus.WAITING
    assert transport.mark_scanned().status is ScanStatus.SCANNED
    assert transport.confirm_login().status is ScanStatus.CONFIRMED

    incoming = transport.inject_message("chat-1", "你好", sender_id="u-1")
    assert transport.receive(timeout=0.01) == incoming
    assert transport.receive() is None
    outgoing = transport.send("chat-1", "回复")
    assert transport.sent_messages == (outgoing,)


def test_adapter_converts_markdown_before_sending():
    transport = MockWechatTransport()
    adapter = WechatAdapter(transport)
    sent = adapter.send("chat-1", "**完成**")
    assert sent.text == "完成"


def test_transport_rejects_use_after_close():
    transport = MockWechatTransport()
    transport.close()
    assert transport.receive() is None
    try:
        transport.send("chat", "text")
    except RuntimeError:
        pass
    else:
        raise AssertionError("closed transport must reject sends")
