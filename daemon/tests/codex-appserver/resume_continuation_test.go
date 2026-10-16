package appserver_test

import (
	"context"
	"fmt"
	"reflect"
	"sync/atomic"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/appserver"
	"github.com/gorilla/websocket"
)

func TestManagedResumeRouteContinuesOnSameLoadedServer(t *testing.T) {
	var loaded atomic.Bool
	var resumes, starts, loadedChecks atomic.Int32
	path, cleanup := fakeAppServer(t, func(conn *websocket.Conn) {
		reads := 0
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
				if !reflect.DeepEqual(request.Params, map[string]any{"threadId": "session", "includeTurns": false}) {
					t.Error("continuation changed target")
					return
				}
				reads++
				status := "notLoaded"
				if loaded.Load() {
					status = "idle"
				}
				result = resumedThread("session", status)
			case "thread/loaded/list":
				loadedChecks.Add(1)
				if !loaded.Load() {
					t.Error("loaded proof used before exact idle state")
					return
				}
				result = map[string]any{"data": []string{"session"}}
			case "thread/resume":
				if loaded.Load() || !reflect.DeepEqual(request.Params, map[string]any{"threadId": "session", "excludeTurns": true}) {
					t.Error("continuation reacquired writer or changed target")
					return
				}
				resumes.Add(1)
				loaded.Store(true)
				result = resumedThread("session", "idle")
			case "turn/start":
				if reads != 2 || !loaded.Load() || request.Params["threadId"] != "session" {
					t.Error("continuation skipped fresh exact idle proof")
					return
				}
				turn := starts.Add(1)
				result = map[string]any{"turn": map[string]any{"id": fmt.Sprintf("managed-turn-%d", turn)}}
			default:
				t.Errorf("unexpected method: %s", request.Method)
				return
			}
			if err := conn.WriteJSON(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result}); err != nil {
				t.Errorf("response: %v", err)
				return
			}
		}
	})
	defer cleanup()
	adapter := appserver.NewAppServerAdapter(path)
	ctx, cancel := context.WithTimeout(context.Background(), resumeProtocolTimeout)
	defer cancel()
	for step := 1; step <= 2; step++ {
		turnID, err := adapter.ResumeSend(ctx, "session", fmt.Sprintf("step %d", step))
		if err != nil || turnID != fmt.Sprintf("managed-turn-%d", step) {
			t.Fatalf("managed continuation step=%d turn=%s error=%v", step, turnID, err)
		}
	}
	if resumes.Load() != 1 || starts.Load() != 2 || loadedChecks.Load() != 1 {
		t.Fatalf("continuation repeated resume or skipped loaded proof: resumes=%d starts=%d loadedChecks=%d", resumes.Load(), starts.Load(), loadedChecks.Load())
	}
}
