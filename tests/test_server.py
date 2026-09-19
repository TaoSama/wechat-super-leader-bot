import json
import threading
import urllib.request

from super_leader.app import SuperLeader
from super_leader.server import serve


def test_control_plane_health_and_message(tmp_path):
    server = serve(SuperLeader(tmp_path), port=0, auth_token="test-token")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        base = f"http://127.0.0.1:{server.server_port}"
        assert json.loads(urllib.request.urlopen(base + "/health").read())["ok"] is True
        request = urllib.request.Request(base + "/messages", data=json.dumps({"chat_id": "c", "text": "/help"}).encode(), headers={"Authorization": "Bearer test-token", "Content-Type": "application/json"})
        assert "/sessions" in json.loads(urllib.request.urlopen(request).read())["text"]
    finally:
        server.shutdown()
        server.server_close()

