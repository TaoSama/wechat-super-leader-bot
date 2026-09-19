from super_leader.codex_sessions import CodexSessionManager
from super_leader.nodes import NodeRegistry
from super_leader.wechat import MockWeChatTransport, markdown_for_wechat


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
