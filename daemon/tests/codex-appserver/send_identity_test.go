package appserver_test

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/appserver"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/gorilla/websocket"
)

func TestSendPromptRequiresExactValidTurnID(t *testing.T) {
	for _, tc := range []struct {
		name  string
		id    any
		valid bool
	}{
		{"missing", nil, false}, {"non-string", 42, false}, {"blank", "", false}, {"spaces", "   ", false},
		{"leading", " target", false}, {"trailing", "target ", false}, {"embedded-space", "one two", false},
		{"tab", "one\ttwo", false}, {"newline", "one\ntwo", false}, {"unicode-space", "one\u00a0two", false},
		{"nul", "one\x00two", false}, {"control", "one\x01two", false}, {"delete", "one\x7ftwo", false},
		{"overlong", strings.Repeat("x", protocol.MaxTurnIDLength+1), false},
		{"secret-malformed", "PRIVATE_SECRET\nprivate/path", false},
		{"valid", "target", true}, {"maximum", strings.Repeat("x", protocol.MaxTurnIDLength), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var dispatches atomic.Int32
			sock, cleanup := historyServer(t, func(method string, params map[string]any) map[string]any {
				switch method {
				case "thread/loaded/list":
					return map[string]any{"data": []string{"session"}}
				case "thread/read":
					if params["threadId"] != "session" || params["includeTurns"] != false {
						t.Error("incorrect preflight target")
					}
					return map[string]any{"thread": map[string]any{"id": "session", "status": "idle"}}
				case "turn/start":
					dispatches.Add(1)
					turn := map[string]any{"secret": "PRIVATE_SECRET"}
					if tc.id != nil {
						turn["id"] = tc.id
					}
					return map[string]any{"turn": turn}
				default:
					t.Errorf("unexpected RPC %s", method)
					return nil
				}
			})
			defer cleanup()
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			output, err := appserver.NewAppServerAdapter(sock).SendPrompt(ctx, "session", "fixture prompt")
			if dispatches.Load() != 1 {
				t.Fatalf("unexpected dispatch count %d", dispatches.Load())
			}
			if tc.valid {
				if err != nil || output != "turnId="+tc.id.(string) {
					t.Fatalf("exact accepted ID lost: %v", err)
				}
			} else if err == nil || !codex.IsUncertain(err) || output != "" || err.Error() != protocol.InvalidTurnAcknowledgement {
				t.Fatalf("invalid native receipt was not statically uncertain: outputBytes=%d err=%v", len(output), err)
			}
		})
	}
}

func TestSendPromptRejectsDifferentOrMissingNativeThread(t *testing.T) {
	for _, tc := range []struct {
		name string
		id   any
	}{
		{"missing", nil}, {"blank", ""}, {"wrong", "other"}, {"leading", " session"}, {"trailing", "session "}, {"non-string", 42}, {"private", "PRIVATE_SECRET"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var dispatches atomic.Int32
			sock, cleanup := historyServer(t, func(method string, params map[string]any) map[string]any {
				switch method {
				case "thread/loaded/list":
					return map[string]any{"data": []string{"session"}}
				case "thread/read":
					thread := map[string]any{"status": "idle"}
					if tc.id != nil {
						thread["id"] = tc.id
					}
					return map[string]any{"thread": thread}
				case "turn/start":
					dispatches.Add(1)
					return map[string]any{"turn": map[string]any{"id": "target"}}
				default:
					t.Errorf("unexpected RPC %s", method)
					return nil
				}
			})
			defer cleanup()
			output, err := appserver.NewAppServerAdapter(sock).SendPrompt(context.Background(), "session", "fixture prompt")
			if err == nil || codex.IsUncertain(err) || output != "" || dispatches.Load() != 0 || strings.Contains(err.Error(), "PRIVATE") {
				t.Fatalf("native target mismatch did not block dispatch: calls=%d err=%v", dispatches.Load(), err)
			}
		})
	}
}

func TestSendPromptRejectsIdentifiersRepairedByJSONDecoder(t *testing.T) {
	for _, tc := range []struct {
		name      string
		encodedID []byte
	}{
		{"lone-high-surrogate", []byte("\"\\ud800\"")},
		{"lone-low-surrogate", []byte("\"\\udfff\"")},
		{"replacement-character", []byte("\"\\ufffd\"")},
		{"invalid-utf8", []byte{'"', 0xff, '"'}},
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
					case "initialized":
						continue
					case "initialize":
						result = map[string]any{}
					case "thread/loaded/list":
						result = map[string]any{"data": []string{"session"}}
					case "thread/read":
						result = map[string]any{"thread": map[string]any{"id": "session", "status": "idle"}}
					case "turn/start":
						identity, err := json.Marshal(request["id"])
						if err != nil {
							t.Errorf("encode fake RPC identity: %v", err)
							return
						}
						payload := append([]byte("{\"id\":"+string(identity)+",\"result\":{\"turn\":{\"id\":"), tc.encodedID...)
						payload = append(payload, []byte("}}}")...)
						if err := conn.WriteMessage(websocket.TextMessage, payload); err != nil {
							t.Errorf("write raw JSON fixture: %v", err)
						}
						continue
					default:
						t.Errorf("unexpected RPC %v", request["method"])
						return
					}
					if err := conn.WriteJSON(map[string]any{"id": request["id"], "result": result}); err != nil {
						return
					}
				}
			})
			defer cleanup()
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			output, err := appserver.NewAppServerAdapter(sock).SendPrompt(ctx, "session", "fixture prompt")
			if err == nil || !codex.IsUncertain(err) || output != "" || err.Error() != protocol.InvalidTurnAcknowledgement {
				t.Fatal("JSON-decoder-repaired identifier established an accepted turn")
			}
		})
	}
}
