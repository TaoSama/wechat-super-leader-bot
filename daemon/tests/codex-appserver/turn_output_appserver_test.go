package appserver_test

import (
	"context"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/appserver"
	"github.com/gorilla/websocket"
)

func TestAppServerExactTurnDistinguishesMissingAndEmptyOutput(t *testing.T) {
	for _, tc := range []struct {
		name      string
		turn      map[string]any
		wantError bool
	}{
		{"missing", map[string]any{}, true},
		{"null", map[string]any{"items": nil}, true},
		{"wrong-container", map[string]any{"items": "unavailable"}, true},
		{"missing-text", map[string]any{"items": []any{map[string]any{"type": "agentMessage"}}}, true},
		{"nonstring-text", map[string]any{"items": []any{map[string]any{"type": "agentMessage", "text": nil}}}, true},
		{"recorded-empty-items", map[string]any{"items": []any{}}, false},
		{"recorded-empty-text", map[string]any{"items": []any{map[string]any{"type": "agentMessage", "text": ""}}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.turn["id"], tc.turn["status"] = "target", "completed"
			socket, cleanup := fakeAppServer(t, func(conn *websocket.Conn) {
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
						result = map[string]any{"thread": map[string]any{"id": "session", "turns": []any{tc.turn}}}
					default:
						t.Errorf("unexpected mutation: %v", request["method"])
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
			observation, err := appserver.NewAppServerAdapter(socket).InspectTurn(ctx, "session", "target")
			if (err != nil) != tc.wantError || err == nil && (observation.Status != "completed" || observation.Output != "") {
				t.Fatalf("observation=%+v error=%v", observation, err)
			}
		})
	}
}
