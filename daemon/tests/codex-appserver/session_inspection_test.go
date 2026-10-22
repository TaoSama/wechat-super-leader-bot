package appserver_test

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/appserver"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/gorilla/websocket"
)

func TestCatalogIdentityInspectionReadsExactThreadWithoutRestoring(t *testing.T) {
	for _, tc := range []struct {
		name, id, status      string
		wantError, wantResume bool
	}{
		{"unloaded", "session", "notLoaded", false, true},
		{"idle", "session", "idle", false, true},
		{"active", "session", "active", false, false},
		{"unknown", "session", "unknown", false, false},
		{"wrong-id", "other", "notLoaded", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path, cleanup := fakeAppServer(t, func(conn *websocket.Conn) {
				for {
					var request struct {
						ID     any            `json:"id"`
						Method string         `json:"method"`
						Params map[string]any `json:"params"`
					}
					if err := conn.ReadJSON(&request); err != nil {
						return
					}
					var result map[string]any
					switch request.Method {
					case "initialize":
						result = map[string]any{}
					case "initialized":
						continue
					case "thread/read":
						if request.Params["threadId"] != "session" || request.Params["includeTurns"] != false {
							t.Error("inexact or body-bearing inspection")
							return
						}
						result = resumedThread(tc.id, tc.status)
					default:
						t.Errorf("inspection mutated or called unexpected method %s", request.Method)
						return
					}
					if err := conn.WriteJSON(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result}); err != nil {
						t.Errorf("fixture response: %v", err)
						return
					}
				}
			})
			defer cleanup()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			got, err := appserver.NewAppServerAdapter(path).InspectSession(ctx, "session")
			if (err != nil) != tc.wantError {
				t.Fatalf("inspection result=%+v err=%v", got, err)
			}
			if err == nil && (got.ID != "session" || got.Loaded == nil || *got.Loaded || got.Status != tc.status || slices.Contains(got.Capabilities, protocol.CapabilityResumeSend) != tc.wantResume || got.ObservedAt == "") {
				t.Fatalf("invalid exact live proof: %+v", got)
			}
		})
	}
}
