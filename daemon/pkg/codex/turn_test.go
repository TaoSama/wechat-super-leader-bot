package codex_test

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/gorilla/websocket"
)

func TestInspectExactTurn(t *testing.T) {
	for _, tc := range []struct {
		name, status, threadID, targetID string
		wantError                        bool
	}{
		{"completed-not-last", "completed", "session", "target", false},
		{"running", "inProgress", "session", "target", false},
		{"failed", "failed", "session", "target", false},
		{"interrupted", "interrupted", "session", "target", false},
		{"unknown-alias", "success", "session", "target", true},
		{"missing", "completed", "session", "different", true},
		{"wrong-thread", "completed", "other", "target", true},
		{"missing-thread-id", "completed", "", "target", true},
		{"padded-thread-id", "completed", " session ", "target", true},
		{"padded-turn-id", "completed", "session", " target ", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sock, cleanup := fakeAppServer(t, func(conn *websocket.Conn) {
				for {
					var request map[string]any
					if err := conn.ReadJSON(&request); err != nil {
						return
					}
					var result map[string]any
					switch request["method"] {
					case "initialize":
						result = map[string]any{}
					case "initialized":
						continue
					case "thread/read":
						params, ok := request["params"].(map[string]any)
						if !ok || params["threadId"] != "session" || params["includeTurns"] != true {
							t.Error("incorrect thread read parameters")
							return
						}
						result = map[string]any{"thread": map[string]any{"id": tc.threadID, "status": "idle", "turns": []any{
							map[string]any{"id": tc.targetID, "status": tc.status, "error": map[string]any{"message": "secret-test-token"}, "items": []any{map[string]any{"type": "agentMessage", "text": strings.Repeat("界", 5000)}}},
							map[string]any{"id": "last-other-turn", "status": "completed", "items": []any{map[string]any{"type": "agentMessage", "text": "WRONG TURN"}}},
						}}}
					default:
						t.Errorf("unexpected RPC (must be readonly): %v", request["method"])
						return
					}
					if err := conn.WriteJSON(map[string]any{"id": request["id"], "result": result}); err != nil {
						t.Errorf("fixture write: %v", err)
						return
					}
				}
			})
			defer cleanup()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			observation, err := codex.NewAppServerAdapter(sock).InspectTurn(ctx, "session", "target")
			if tc.wantError {
				if err == nil {
					t.Fatalf("expected rejection: %+v", observation)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if observation.Status != tc.status || strings.Contains(observation.Output, "WRONG TURN") || len([]rune(observation.Output)) > 4050 {
				t.Fatalf("wrong observation: status=%s outputLength=%d", observation.Status, len(observation.Output))
			}
			if strings.Contains(observation.Error, "secret-test-token") {
				t.Fatal("upstream error leaked")
			}
		})
	}
}

// Opt-in only. Reads an existing turn; never starts/resumes or mutates a session.
func TestInspectLiveTurnReadonly(t *testing.T) {
	sessionID := os.Getenv("LIVE_CODEX_SESSION")
	if sessionID == "" {
		t.Skip("LIVE_CODEX_SESSION not set")
	}
	base, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	sock := os.Getenv("CODEX_APP_SERVER_SOCKET")
	if sock == "" {
		sock = filepath.Join(base, config.CodexSocketRelPath)
	}
	adapter := codex.NewAppServerAdapter(sock)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	text, err := adapter.ReadSession(ctx, sessionID)
	if err != nil {
		t.Fatal("live readonly session read failed")
	}
	turns := regexp.MustCompile(`--- Turn ([^\s]+) \(`).FindAllStringSubmatch(text, -1)
	if len(turns) == 0 {
		t.Fatal("no existing turn available for readonly verification")
	}
	observation, err := adapter.InspectTurn(ctx, sessionID, turns[len(turns)-1][1])
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("existing turn status=%s, outputBytes=%d; no prompt sent", observation.Status, len(observation.Output))
}
