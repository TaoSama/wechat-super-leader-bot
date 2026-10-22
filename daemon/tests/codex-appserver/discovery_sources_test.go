package appserver_test

import (
	"context"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/appserver"
	"github.com/gorilla/websocket"
)

func TestDiscoveryLoadedSupplementRequiresUserSessionSource(t *testing.T) {
	for _, test := range []struct {
		name   string
		source any
		keep   bool
	}{
		{"cli", "cli", true},
		{"desktop", "vscode", true},
		{"app-server", "appServer", true},
		{"subagent", map[string]any{"subAgent": map[string]any{"thread_spawn": map[string]any{"parent_thread_id": "parent"}}}, false},
		{"named-subagent", "subAgent", false},
		{"exec", "exec", false},
		{"unknown", "unknown", false},
		{"missing", nil, false},
		{"malformed", []string{"cli"}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			sock, cleanup := historyServer(t, func(method string, params map[string]any) map[string]any {
				switch method {
				case "thread/loaded/list":
					return map[string]any{"data": []string{"supplement"}}
				case "thread/list":
					return map[string]any{"data": []any{map[string]any{"id": "parent", "name": "Original title", "source": "vscode", "status": "notLoaded"}}}
				case "thread/read":
					if params["threadId"] != "supplement" || params["includeTurns"] != false {
						t.Error("supplement must read only exact target metadata")
					}
					return map[string]any{"thread": map[string]any{"id": "supplement", "name": "Named worker", "source": test.source, "status": "idle"}}
				default:
					t.Errorf("unexpected RPC: %s", method)
					return nil
				}
			})
			defer cleanup()
			sessions, err := appserver.NewAppServerAdapter(sock).DiscoverSessions(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			wantCount := 1
			if test.keep {
				wantCount++
			}
			if len(sessions) != wantCount || sessions[0].ID != "parent" || sessions[0].Title != "Original title" {
				t.Fatalf("source filter or parent identity changed: %+v", sessions)
			}
			if test.keep && (sessions[1].ID != "supplement" || sessions[1].Title != "Named worker" || sessions[1].Loaded == nil || !*sessions[1].Loaded) {
				t.Fatalf("valid loaded user session was lost: %+v", sessions)
			}
		})
	}
}

func TestDiscoveryDoesNotInventUnverifiedLoadedSessions(t *testing.T) {
	for _, test := range []struct {
		name   string
		result map[string]any
	}{
		{"missing-thread", map[string]any{}},
		{"wrong-id", map[string]any{"thread": map[string]any{"id": "other", "source": "cli", "name": "Wrong identity"}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			sock, cleanup := historyServer(t, func(method string, params map[string]any) map[string]any {
				switch method {
				case "thread/loaded/list":
					return map[string]any{"data": []string{"bad", "good"}}
				case "thread/list":
					return map[string]any{"data": []any{}}
				case "thread/read":
					if params["threadId"] == "bad" {
						return test.result
					}
					return map[string]any{"thread": map[string]any{"id": "good", "source": "cli", "name": "Good title", "status": "idle"}}
				default:
					t.Errorf("unexpected RPC: %s", method)
					return nil
				}
			})
			defer cleanup()
			sessions, err := appserver.NewAppServerAdapter(sock).DiscoverSessions(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if len(sessions) != 1 || sessions[0].ID != "good" {
				t.Fatalf("unverified placeholder leaked or valid target disappeared: %+v", sessions)
			}
		})
	}
}

func TestDiscoverySupplementReadFailureDoesNotCreatePlaceholder(t *testing.T) {
	sock, cleanup := fakeAppServer(t, func(conn *websocket.Conn) {
		for {
			var request struct {
				ID     any            `json:"id"`
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			if err := conn.ReadJSON(&request); err != nil {
				return
			}
			if request.Method == "initialized" {
				continue
			}
			response := map[string]any{"id": request.ID, "result": map[string]any{}}
			switch request.Method {
			case "initialize":
			case "thread/loaded/list":
				response["result"] = map[string]any{"data": []string{"bad", "good"}}
			case "thread/list":
				response["result"] = map[string]any{"data": []any{}}
			case "thread/read":
				if request.Params["threadId"] == "bad" {
					delete(response, "result")
					response["error"] = map[string]any{"code": -32602, "message": "Thread unavailable"}
				} else {
					response["result"] = map[string]any{"thread": map[string]any{"id": "good", "source": "vscode", "status": "idle"}}
				}
			default:
				t.Errorf("unexpected RPC: %s", request.Method)
				return
			}
			if err := conn.WriteJSON(response); err != nil {
				t.Errorf("fixture write: %v", err)
				return
			}
		}
	})
	defer cleanup()
	sessions, err := appserver.NewAppServerAdapter(sock).DiscoverSessions(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].ID != "good" || sessions[0].Title != "" {
		t.Fatalf("read failure created a placeholder or hid a genuine untitled session: %+v", sessions)
	}
}
