from super_leader.doctor import run_check


def test_doctor_reports_writable_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("WECHAT_ILINK_BASE_URL", "https://127.0.0.1:1")
    checks = dict((name, ok) for name, ok, _ in run_check(tmp_path))
    assert checks["数据目录"] is True
    assert "codex CLI" in checks
