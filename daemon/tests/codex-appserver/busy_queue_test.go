package appserver_test

import (
	"context"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/appserver"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/gorilla/websocket"
)

func TestBusyDiscoveryKeepsQueueRoutesWithoutGrantingMutation(t *testing.T) {
	for _, status := range []string{"active", "waitingApproval", "waitingUserInput", "unknown", "systemError", "unrecognized"} {
		t.Run(status, func(t *testing.T) {
			var starts, resumes atomic.Int32
			path, cleanup := fakeAppServer(t, func(conn *websocket.Conn) {
				for {
					var request struct {
						ID     any    `json:"id"`
						Method string `json:"method"`
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
					case "thread/loaded/list":
						result = map[string]any{"data": []string{"session"}}
					case "thread/list":
						result = map[string]any{"data": []any{map[string]any{"id": "session", "status": map[string]any{"type": status}}}}
					case "thread/read":
						result = resumedThread("session", status)
					case "turn/start":
						starts.Add(1)
						result = map[string]any{"turn": map[string]any{"id": "unexpected-turn"}}
					case "thread/resume":
						resumes.Add(1)
						result = resumedThread("session", "idle")
					default:
						t.Errorf("unexpected RPC: %s", request.Method)
						return
					}
					if err := conn.WriteJSON(map[string]any{"id": request.ID, "result": result}); err != nil {
						t.Errorf("fixture response: %v", err)
						return
					}
				}
			})
			defer cleanup()
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			adapter := appserver.NewAppServerAdapter(path)
			sessions, err := adapter.DiscoverSessions(ctx)
			if err != nil || len(sessions) != 1 {
				t.Fatalf("discovery failed: %+v %v", sessions, err)
			}
			queueable := status == "active" || status == "waitingApproval" || status == "waitingUserInput"
			if slices.Contains(sessions[0].Capabilities, protocol.ActionSend) != queueable ||
				slices.Contains(sessions[0].Capabilities, protocol.CapabilityResumeSend) != queueable {
				t.Fatalf("incorrect queue routes: %+v", sessions[0])
			}
			if _, err := adapter.SendPrompt(ctx, "session", "next turn"); err == nil {
				t.Fatal("non-idle native send was accepted")
			}
			if _, err := adapter.ResumeSend(ctx, "session", "next turn"); err == nil {
				t.Fatal("non-idle resume send was accepted")
			}
			if starts.Load() != 0 || resumes.Load() != 0 {
				t.Fatalf("busy/unknown target mutated: starts=%d resumes=%d", starts.Load(), resumes.Load())
			}
		})
	}
}
