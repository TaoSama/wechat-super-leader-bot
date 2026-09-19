from super_leader.app import SuperLeader


def test_help_and_memory(tmp_path):
    app = SuperLeader(tmp_path)
    assert "/sessions" in app.handle("/help").text
    assert "已保存" in app.handle("/remember 明天扫码").text
    assert app.memory.search("local", "扫码") == ["明天扫码"]
    assert "明天扫码" in app.handle("/recall 扫码").text


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


def test_skills_include_super_leader_builtins(tmp_path):
    app = SuperLeader(tmp_path)
    names = app.skills.list_skills()
    assert "session-management" in names
    assert "node-communication" in names


def test_skill_command_builds_and_sends_prompt(tmp_path):
    app = SuperLeader(tmp_path)
    seen = []
    app.desktop.send_turn = lambda thread_id, prompt: seen.append((thread_id, prompt)) or "done"
    assert app.handle("/skill session-management thread-1 查看任务").text == "done"
    assert seen[0][0] == "thread-1"
    assert "session-management" in seen[0][1]


def test_dispatch_command(tmp_path):
    app = SuperLeader(tmp_path)
    token = app.nodes.register("mini", "local")
    assert app.nodes.heartbeat("mini", token)
    result = app.handle("/dispatch mini 检查状态")
    assert result.data and result.data["accepted"] is True
