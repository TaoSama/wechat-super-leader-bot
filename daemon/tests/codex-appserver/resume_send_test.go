package appserver_test

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/appserver"
	"github.com/gorilla/websocket"
)

const resumeProtocolTimeout = 3 * time.Second

type resumeProtocolCase struct {
	initialID, initialStatus       string
	resumeID, resumeStatus         string
	readID, readStatus             string
	resumeError, closeAt, cancelAt string
	turnID                         string
	loaded                         bool
}

func resumedThread(id, status string) map[string]any {
	return map[string]any{"thread": map[string]any{"id": id, "status": map[string]any{"type": status}}}
}

func TestExplicitResumeSendProtocolAndFailureBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name                  string
		edit                  func(*resumeProtocolCase)
		wantResume, wantStart int32
		wantError, uncertain  bool
	}{
		{"unloaded", func(*resumeProtocolCase) {}, 1, 1, false, false},
		{"idle", func(c *resumeProtocolCase) { c.initialStatus = "idle" }, 1, 1, false, false},
		{"already-loaded-idle", func(c *resumeProtocolCase) { c.initialStatus, c.loaded = "idle", true }, 0, 1, false, false},
		{"loaded-became-active", func(c *resumeProtocolCase) { c.initialStatus, c.loaded, c.readStatus = "idle", true, "active" }, 0, 0, true, false},
		{"loaded-wrong-final-id", func(c *resumeProtocolCase) { c.initialStatus, c.loaded, c.readID = "idle", true, "other" }, 0, 0, true, false},
		{"loaded-lost-start-ack", func(c *resumeProtocolCase) { c.initialStatus, c.loaded, c.closeAt = "idle", true, "turn/start" }, 0, 1, true, true},
		{"loaded-proof-unavailable", func(c *resumeProtocolCase) { c.initialStatus, c.loaded, c.closeAt = "idle", true, "thread/loaded/list" }, 0, 0, true, false},
		{"wrong-initial-id", func(c *resumeProtocolCase) { c.initialID = "other" }, 0, 0, true, false},
		{"active", func(c *resumeProtocolCase) { c.initialStatus = "active" }, 0, 0, true, false},
		{"unknown", func(c *resumeProtocolCase) { c.initialStatus = "unknown" }, 0, 0, true, false},
		{"writer-conflict", func(c *resumeProtocolCase) { c.resumeError = "active writer already owns thread" }, 1, 0, true, false},
		{"idle-other-writer", func(c *resumeProtocolCase) {
			c.initialStatus, c.resumeError = "idle", "active writer already owns thread"
		}, 1, 0, true, false},
		{"wrong-resume-id", func(c *resumeProtocolCase) { c.resumeID = "other" }, 1, 0, true, false},
		{"resume-not-idle", func(c *resumeProtocolCase) { c.resumeStatus = "active" }, 1, 0, true, false},
		{"wrong-read-id", func(c *resumeProtocolCase) { c.readID = "other" }, 1, 0, true, false},
		{"became-active", func(c *resumeProtocolCase) { c.readStatus = "active" }, 1, 0, true, false},
		{"resume-disconnect", func(c *resumeProtocolCase) { c.closeAt = "thread/resume" }, 1, 0, true, false},
		{"lost-turn-ack", func(c *resumeProtocolCase) { c.closeAt = "turn/start" }, 1, 1, true, true},
		{"invalid-turn", func(c *resumeProtocolCase) { c.turnID = "bad turn" }, 1, 1, true, true},
		{"canceled-before-resume", func(c *resumeProtocolCase) { c.cancelAt = "initial-read" }, 0, 0, true, false},
		{"canceled-before-start", func(c *resumeProtocolCase) { c.cancelAt = "final-read" }, 1, 0, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := resumeProtocolCase{initialID: "session", initialStatus: "notLoaded", resumeID: "session", resumeStatus: "idle", readID: "session", readStatus: "idle", turnID: "exact-resumed-turn"}
			tc.edit(&cfg)
			ctx, cancel := context.WithTimeout(context.Background(), resumeProtocolTimeout)
			defer cancel()
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
							t.Error("read changed target or requested recorded bodies")
							return
						}
						reads++
						if reads == 1 {
							result = resumedThread(cfg.initialID, cfg.initialStatus)
							if cfg.cancelAt == "initial-read" {
								cancel()
							}
						} else if reads == 2 && (resumes.Load() == 1 || (cfg.loaded && loadedChecks.Load() == 1)) {
							result = resumedThread(cfg.readID, cfg.readStatus)
							if cfg.cancelAt == "final-read" {
								cancel()
							}
						} else {
							t.Error("unexpected extra preflight read")
							return
						}
					case "thread/loaded/list":
						loadedChecks.Add(1)
						if reads != 1 || cfg.initialStatus != "idle" {
							t.Error("loaded proof before exact idle preflight")
							return
						}
						ids := []string{}
						if cfg.loaded {
							ids = append(ids, "session")
						}
						result = map[string]any{"data": ids}
					case "thread/resume":
						resumes.Add(1)
						if reads != 1 || !reflect.DeepEqual(request.Params, map[string]any{"threadId": "session", "excludeTurns": true}) {
							t.Error("resume before target proof or with setting overrides")
							return
						}
						if cfg.resumeError != "" {
							if err := conn.WriteJSON(map[string]any{"jsonrpc": "2.0", "id": request.ID, "error": map[string]any{"code": -32000, "message": cfg.resumeError}}); err != nil {
								t.Errorf("writer response: %v", err)
							}
							continue
						}
						result = resumedThread(cfg.resumeID, cfg.resumeStatus)
					case "turn/start":
						starts.Add(1)
						if reads != 2 || (!cfg.loaded && resumes.Load() != 1) || !reflect.DeepEqual(request.Params, map[string]any{"threadId": "session", "input": []any{map[string]any{"type": "text", "text": "explicit prompt"}}}) {
							t.Error("turn/start without exact preflight or changed input")
							return
						}
						result = map[string]any{"turn": map[string]any{"id": cfg.turnID}}
					default:
						t.Errorf("unexpected method: %s", request.Method)
						return
					}
					if cfg.closeAt == request.Method {
						return
					}
					if err := conn.WriteJSON(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result}); err != nil {
						if ctx.Err() == nil {
							t.Errorf("fixture response: %v", err)
						}
						return
					}
				}
			})
			defer cleanup()
			adapter := appserver.NewAppServerAdapter(path)
			turnID, err := adapter.ResumeSend(ctx, "session", "explicit prompt")
			if (err != nil) != tc.wantError || codex.IsUncertain(err) != tc.uncertain || resumes.Load() != tc.wantResume || starts.Load() != tc.wantStart {
				t.Fatalf("resume result turn=%q error=%v resumes=%d starts=%d", turnID, err, resumes.Load(), starts.Load())
			}
			if err == nil && turnID != cfg.turnID {
				t.Fatal("lost exact native turn ID")
			}
			if cfg.resumeError != "" && !strings.Contains(fmt.Sprint(err), cfg.resumeError) {
				t.Fatal("writer rejection reason lost")
			}
			if cfg.initialStatus == "idle" && loadedChecks.Load() != 1 {
				t.Fatal("idle continuation bypassed exact managed loaded membership")
			}
		})
	}
}

func TestResumeSendRejectsInvalidInputWithoutConnecting(t *testing.T) {
	adapter := appserver.NewAppServerAdapter("/never-connect.sock")
	for _, args := range [][2]string{{"", "prompt"}, {"terminal:pane", "prompt"}, {"session", " "}, {"session", string([]byte{0xff})}} {
		if _, err := adapter.ResumeSend(context.Background(), args[0], args[1]); err == nil || strings.Contains(err.Error(), "socket") {
			t.Fatalf("invalid input reached transport: %v", err)
		}
	}
}
