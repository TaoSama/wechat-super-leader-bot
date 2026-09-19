from super_leader.app import SuperLeader


def test_help_and_memory(tmp_path):
    app = SuperLeader(tmp_path)
    assert "/sessions" in app.handle("/help").text
    assert "已保存" in app.handle("/remember 明天扫码").text
    assert app.memory.search("local", "扫码") == ["明天扫码"]

