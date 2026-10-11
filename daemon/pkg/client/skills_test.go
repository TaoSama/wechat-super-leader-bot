package client_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/client"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/skills"
	"github.com/gorilla/websocket"
)

func TestSkillDispatchValidatesDigestAndPreservesUserTask(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "SKILL.md")
	content := "---\nname: test-skill\ndescription: Test fixture\n---\nRead only.\n"
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	catalog, err := skills.Scan([]string{dir})
	if err != nil || len(catalog) != 1 {
		t.Fatalf("scan: %v, %v", catalog, err)
	}
	adapter := &mockAdapter{sendAcks: map[string]string{"s1": "turnId=fixture-turn"}}
	d := client.NewDaemon(&config.Config{NodeID: "test", SkillRoots: []string{dir}}, adapter)
	cmd := protocol.ControllerCommandMessage{Type: "command", CommandID: "c1", NodeID: "test", SessionID: "s1", Action: protocol.ActionSend,
		Prompt: "检查测试，不修改文件", ExpiresAt: time.Now().Add(time.Minute).Format(time.RFC3339Nano),
		Skills: []skills.Ref{{ID: catalog[0].ID, Digest: catalog[0].Digest}}}
	res := d.ExecuteCommand(context.Background(), cmd)
	if res.Status != protocol.StatusAccepted {
		t.Fatalf("send failed: %+v", res)
	}
	if len(adapter.sendCalls) != 1 || !strings.Contains(adapter.sendCalls[0], path) || !strings.Contains(adapter.sendCalls[0], cmd.Prompt) || !strings.Contains(adapter.sendCalls[0], catalog[0].Digest) {
		t.Fatalf("missing skill reference or task: %v", adapter.sendCalls)
	}
	if err := os.WriteFile(path, []byte(content+"Changed"), 0600); err != nil {
		t.Fatal(err)
	}
	// An already dispatched identical request reuses its receipt; a fresh command must fail.
	if replay := d.ExecuteCommand(context.Background(), cmd); replay.Status != protocol.StatusAccepted {
		t.Fatalf("replay: %+v", replay)
	}
	cmd.CommandID = "c2"
	if stale := d.ExecuteCommand(context.Background(), cmd); stale.Status != protocol.StatusFailed {
		t.Fatalf("changed skill dispatched: %+v", stale)
	}
	if len(adapter.sendCalls) != 1 {
		t.Fatal("skill change caused an extra send")
	}
	cmd.CommandID = "c1"
	cmd.Skills = nil
	if conflict := d.ExecuteCommand(context.Background(), cmd); conflict.Status != protocol.StatusFailed {
		t.Fatalf("different skill payload reused ID: %+v", conflict)
	}
}

func TestReadCannotInvokeSkills(t *testing.T) {
	d := client.NewDaemon(&config.Config{NodeID: "test"}, &mockAdapter{})
	result := d.ExecuteCommand(context.Background(), protocol.ControllerCommandMessage{Type: "command", CommandID: "read-skill", NodeID: "test",
		SessionID: "s1", Action: protocol.ActionRead, ExpiresAt: time.Now().Add(time.Minute).Format(time.RFC3339Nano),
		Skills: []skills.Ref{{ID: strings.Repeat("a", 64), Digest: strings.Repeat("b", 64)}}})
	if result.Status != protocol.StatusFailed {
		t.Fatalf("read with skill allowed: %+v", result)
	}
}

func TestDaemonPublishesSkillCatalogInHelloAndHeartbeat(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("---\nname: catalog-test\ndescription: fixture\n---\nNo execution"), 0600); err != nil {
		t.Fatal(err)
	}
	frames := make(chan map[string]any, 4)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade failed: %v", err)
			return
		}
		defer func() {
			if err := conn.Close(); err != nil {
				t.Logf("close: %v", err)
			}
		}()
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			} // Client shutdown terminates this test connection.
			var frame map[string]any
			if err := json.Unmarshal(data, &frame); err != nil {
				t.Errorf("invalid frame: %v", err)
				return
			}
			select {
			case frames <- frame:
			default:
			}
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	daemon := client.NewDaemon(&config.Config{NodeID: "test", NodeToken: "fixture", ControllerURL: "ws" + strings.TrimPrefix(server.URL, "http"),
		HeartbeatInterval: 20 * time.Millisecond, SkillRoots: []string{dir}}, &mockAdapter{})
	go func() { done <- daemon.Run(ctx) }()
	defer func() {
		cancel()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("daemon did not exit")
		}
	}()
	for _, kind := range []string{"hello", "heartbeat"} {
		select {
		case frame := <-frames:
			if frame["type"] != kind {
				t.Fatalf("expected %s, got %v", kind, frame["type"])
			}
			entries, ok := frame["skills"].([]any)
			if !ok || len(entries) != 1 {
				t.Fatalf("skill catalog not published: %v", frame)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("no %s frame", kind)
		}
	}
}
