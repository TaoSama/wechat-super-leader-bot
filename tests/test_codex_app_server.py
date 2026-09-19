import shutil

import pytest

from super_leader.codex_app_server import CodexAppServerClient


@pytest.mark.skipif(shutil.which("codex") is None, reason="Codex CLI is not installed")
def test_list_visible_codex_threads():
    client = CodexAppServerClient()
    try:
        threads = client.list_threads(limit=1)
        assert isinstance(threads, list)
        if threads:
            assert "id" in threads[0]
    finally:
        client.close()

