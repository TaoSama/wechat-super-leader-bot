package codex_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// fakeAppServer creates a fake Unix domain websocket server simulating Codex App app-server.
// On macOS sockaddr_un has a 104-byte limit, so we keep socket path under /tmp with a short name.
func fakeAppServer(t *testing.T, handler func(conn *websocket.Conn)) (string, func()) {
	var randBytes [4]byte
	_, _ = rand.Read(randBytes[:])
	sockPath := filepath.Join(os.TempDir(), "cdx_"+hex.EncodeToString(randBytes[:])+".sock")
	_ = os.Remove(sockPath)

	listener, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatalf("failed to listen unix socket: %v", err)
	}

	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		handler(conn)
	}))
	server.Listener = listener
	server.Start()

	cleanup := func() {
		server.Close()
		_ = os.Remove(sockPath)
	}
	return sockPath, cleanup
}

func TestAppServerAdapter_DiscoveryAndRead(t *testing.T) {
	sockPath, cleanup := fakeAppServer(t, func(conn *websocket.Conn) {
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var req map[string]any
			if err := json.Unmarshal(data, &req); err != nil {
				return
			}

			method, _ := req["method"].(string)
			id := req["id"]

			switch method {
			case "initialize":
				_ = conn.WriteJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      id,
					"result":  map[string]any{"userAgent": "fake-codex"},
				})
			case "initialized":
				// notification, no response
			case "thread/loaded/list":
				_ = conn.WriteJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      id,
					"result": map[string]any{
						"data":       []string{"loaded-sess-1"},
						"nextCursor": nil,
					},
				})
			case "thread/list":
				_ = conn.WriteJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      id,
					"result": map[string]any{
						"data": []map[string]any{
							{
								"id":     "loaded-sess-1",
								"title":  "Live Task",
								"status": map[string]any{"type": "idle"},
								"cwd":    "/Users/test",
							},
							{
								"id":     "history-sess-2",
								"title":  "Old Task",
								"status": map[string]any{"type": "notLoaded"},
								"cwd":    "/Users/test",
							},
						},
					},
				})
			case "thread/read":
				params, _ := req["params"].(map[string]any)
				threadID, _ := params["threadId"].(string)
				_ = conn.WriteJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      id,
					"result": map[string]any{
						"thread": map[string]any{
							"id":     threadID,
							"title":  "Test Session " + threadID,
							"status": map[string]any{"type": "idle"},
							"turns": []map[string]any{
								{
									"id":     "turn-101",
									"status": map[string]any{"type": "completed"},
									"items": []map[string]any{
										{
											"type": "userMessage",
											"content": []map[string]any{
												{"type": "text", "text": "Do work"},
											},
										},
										{
											"type":  "agentMessage",
											"phase": "final_answer",
											"text":  "Work finished successfully",
										},
									},
								},
							},
						},
					},
				})
			case "turn/start":
				_ = conn.WriteJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      id,
					"result": map[string]any{
						"turn": map[string]any{
							"id": "turn-202",
						},
					},
				})
			}
		}
	})
	defer cleanup()

	adapter := codex.NewAppServerAdapter(sockPath)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// 1. Discover sessions
	sessions, err := adapter.DiscoverSessions(ctx)
	if err != nil {
		t.Fatalf("DiscoverSessions failed: %v", err)
	}
	if len(sessions) != 2 {
		t.Fatalf("expected 2 sessions, got %d", len(sessions))
	}

	var liveSess, histSess *protocol.Session
	for i := range sessions {
		if sessions[i].ID == "loaded-sess-1" {
			liveSess = &sessions[i]
		} else if sessions[i].ID == "history-sess-2" {
			histSess = &sessions[i]
		}
	}

	if liveSess == nil || histSess == nil {
		t.Fatalf("missing expected sessions: live=%v, hist=%v", liveSess, histSess)
	}

	// Live loaded session has both read and send
	if len(liveSess.Capabilities) != 2 || liveSess.Capabilities[0] != protocol.ActionRead || liveSess.Capabilities[1] != protocol.ActionSend {
		t.Fatalf("expected loaded session to have [read, send], got %v", liveSess.Capabilities)
	}

	// Historical unloaded session is downgraded to read-only
	if len(histSess.Capabilities) != 1 || histSess.Capabilities[0] != protocol.ActionRead {
		t.Fatalf("expected unloaded session to be read-only, got %v", histSess.Capabilities)
	}

	// 2. Read session
	readOut, err := adapter.ReadSession(ctx, "loaded-sess-1")
	if err != nil {
		t.Fatalf("ReadSession failed: %v", err)
	}
	if !strings.Contains(readOut, "Work finished successfully") {
		t.Fatalf("read output missing turn content: %s", readOut)
	}

	// 3. Send prompt on live session
	ack, err := adapter.SendPrompt(ctx, "loaded-sess-1", "Next command")
	if err != nil {
		t.Fatalf("SendPrompt failed on loaded session: %v", err)
	}
	if ack != "turnId=turn-202" {
		t.Fatalf("expected ack turnId=turn-202, got %q", ack)
	}

	// 4. Send prompt on unloaded session must be rejected (no implicit resume)
	_, err = adapter.SendPrompt(ctx, "history-sess-2", "Next command")
	if err == nil {
		t.Fatalf("expected SendPrompt on unloaded session to be rejected")
	}
	if !strings.Contains(err.Error(), "not loaded") {
		t.Fatalf("expected error mentioning not loaded, got: %v", err)
	}
}

func TestAppServerAdapter_SendRejectionWhenActive(t *testing.T) {
	sockPath, cleanup := fakeAppServer(t, func(conn *websocket.Conn) {
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var req map[string]any
			_ = json.Unmarshal(data, &req)
			method, _ := req["method"].(string)
			id := req["id"]

			switch method {
			case "initialize":
				_ = conn.WriteJSON(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{}})
			case "thread/loaded/list":
				_ = conn.WriteJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      id,
					"result":  map[string]any{"data": []string{"busy-sess"}},
				})
			case "thread/read":
				_ = conn.WriteJSON(map[string]any{
					"jsonrpc": "2.0",
					"id":      id,
					"result": map[string]any{
						"thread": map[string]any{
							"id":     "busy-sess",
							"status": map[string]any{"type": "active"}, // user currently running!
						},
					},
				})
			}
		}
	})
	defer cleanup()

	adapter := codex.NewAppServerAdapter(sockPath)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, err := adapter.SendPrompt(ctx, "busy-sess", "interrupting prompt")
	if err == nil {
		t.Fatalf("expected SendPrompt to reject active non-idle session")
	}
	if !strings.Contains(err.Error(), "active (not idle)") {
		t.Fatalf("expected rejection mentioning active (not idle), got: %v", err)
	}
}
