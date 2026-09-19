from super_leader.codex_sessions import CodexSessionManager
from super_leader.nodes import NodeRegistry
from super_leader.wechat import ILinkWeChatTransport, MockWeChatTransport, markdown_for_wechat


def test_markdown_degrades():
    assert markdown_for_wechat("**hi** [docs](https://example.com)") == "hi docs: https://example.com"


def test_mock_transport():
    transport = MockWeChatTransport()
    assert transport.start_login().qr_url.startswith("mock://")
    transport.inbox.append(type("M", (), {"chat_id": "c", "text": "hi", "message_id": "1"})())
    assert list(transport.poll())[0].text == "hi"


def test_registry_auth(tmp_path):
    registry = NodeRegistry(tmp_path / "nodes.db")
    token = registry.register("mini", "http://127.0.0.1:1")
    assert registry.heartbeat("mini", token)
    assert not registry.heartbeat("mini", "bad")
    assert registry.list_nodes()[0].status == "online"


def test_fork_uses_none(tmp_path):
    calls = []

    def runner(*args, **kwargs):
        calls.append(args)
        return type("Result", (), {"returncode": 0, "stdout": "", "stderr": ""})()

    CodexSessionManager(tmp_path, runner=runner).fork("task", "gpt-5.6-sol")
    assert "--fork-turns" in calls[0] and "none" in calls[0]


def test_ilink_transport_login_poll_and_send(tmp_path):
    class FakeTransport(ILinkWeChatTransport):
        def __init__(self, path):
            super().__init__(path, base_url="https://example.invalid")
            self.calls = []
            self.statuses = iter([{"status": "wait"}, {"status": "confirmed", "bot_token": "secret", "ilink_bot_id": "bot-1"}])

        def _get(self, endpoint, timeout=None):
            self.calls.append(("GET", endpoint))
            if "get_bot_qrcode" in endpoint:
                return {"qrcode": "q", "qrcode_img_content": "https://qr.invalid/q"}
            return next(self.statuses)

        def _request(self, endpoint, payload, token=None, timeout=None):
            self.calls.append(("POST", endpoint, payload))
            if endpoint.endswith("getupdates"):
                return {"get_updates_buf": "cursor", "msgs": [{"message_type": 1, "from_user_id": "u1", "context_token": "ctx", "item_list": [{"type": 1, "text_item": {"text": "你好"}}]}]}
            return {}

    transport = FakeTransport(tmp_path / "account.json")
    account = transport.login(poll_interval=0, timeout=1)
    assert account["accountId"] == "bot-1"
    message = next(transport.poll())
    assert message.text == "你好"
    transport.send("u1", "**完成**")
    assert any(call[1].endswith("sendmessage") for call in transport.calls)
