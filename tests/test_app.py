from super_leader.app import SuperLeader


def test_help_and_memory(tmp_path):
    app = SuperLeader(tmp_path)
    assert "/sessions" in app.handle("/help").text
    assert "已保存" in app.handle("/remember 明天扫码").text
    assert app.memory.search("local", "扫码") == ["明天扫码"]


def test_chat_allowlist(tmp_path):
    app = SuperLeader(tmp_path, allowed_chat_ids={"trusted"})
    assert "未被授权" in app.handle("/help", "unknown").text
    assert "/sessions" in app.handle("/help", "trusted").text


def test_explicit_codex_commands(tmp_path):
    app = SuperLeader(tmp_path)
    class Result:
        stdout = "done"
        stderr = ""
    app.sessions.send = lambda session_id, prompt: Result()
    app.sessions.fork = lambda prompt, model=None: Result()
    assert app.handle("/codex s1 检查状态").text == "done"
    assert app.handle("/fork gpt-5.6-sol 写测试").text == "done"
