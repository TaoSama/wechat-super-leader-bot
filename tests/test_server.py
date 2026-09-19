import json
import threading
import urllib.request

from super_leader.app import SuperLeader
from super_leader.node_agent import NodeAgent
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
        register = urllib.request.Request(base + "/nodes/register", data=json.dumps({"name": "mini", "address": "127.0.0.1"}).encode(), headers={"Authorization": "Bearer test-token", "Content-Type": "application/json"})
        node_token = json.loads(urllib.request.urlopen(register).read())["token"]
        dispatch = urllib.request.Request(base + "/nodes/dispatch", data=json.dumps({"node_name": "mini", "task_id": "t1", "payload": "检查"}).encode(), headers={"Authorization": "Bearer test-token", "Content-Type": "application/json"})
        assert json.loads(urllib.request.urlopen(dispatch).read())["accepted"] is True
        tasks_request = urllib.request.Request(base + "/nodes/mini/tasks", headers={"X-Node-Token": node_token})
        assert json.loads(urllib.request.urlopen(tasks_request).read())["tasks"][0]["task_id"] == "t1"
    finally:
        server.shutdown()
        server.server_close()


def test_remote_node_agent_rejects_plain_http_by_default():
    try:
        NodeAgent("http://office.example", "office", "office", "secret")
    except ValueError as error:
        assert "HTTPS" in str(error)
    else:
        raise AssertionError("remote node token transport must require HTTPS")
