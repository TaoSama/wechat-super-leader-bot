package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
)

func TestDesktopOrdinaryThreadSourceBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name string
		raw  json.RawMessage
		want bool
	}{
		{"user", json.RawMessage(`"user"`), true},
		{"explicit-null", json.RawMessage(`null`), true},
		{"agent-created-thread", json.RawMessage(`"agent_created_thread"`), true},
		{"missing", nil, false},
		{"empty", json.RawMessage(`""`), false},
		{"unknown", json.RawMessage(`"future"`), false},
		{"subagent", json.RawMessage(`"subagent"`), false},
		{"automation", json.RawMessage(`"automation"`), false},
		{"aeon", json.RawMessage(`"aeon"`), false},
		{"prefix", json.RawMessage(`"agent_created_thread_extra"`), false},
		{"case", json.RawMessage(`"Agent_created_thread"`), false},
		{"space", json.RawMessage(`" agent_created_thread"`), false},
		{"boolean", json.RawMessage(`true`), false},
		{"number", json.RawMessage(`1`), false},
		{"object", json.RawMessage(`{"type":"user"}`), false},
		{"array", json.RawMessage(`["user"]`), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			settings := desktopControlSettings{ResumeState: "resumed", Mode: "default", ThreadSource: tc.raw}
			if got := settings.ordinaryResumed(); got != tc.want {
				t.Fatalf("settings ordinary=%t want=%t", got, tc.want)
			}
			state := map[string]any{"resumeState": "resumed", "mode": "default"}
			if tc.raw != nil {
				var source any
				if err := json.Unmarshal(tc.raw, &source); err != nil {
					t.Fatal(err)
				}
				state["threadSource"] = source
			}
			if got := historyOrdinary(state); got != tc.want {
				t.Fatalf("history ordinary=%t want=%t", got, tc.want)
			}
			for _, field := range []string{"resumeState", "mode"} {
				settings := settings
				if field == "resumeState" {
					settings.ResumeState = "needs_resume"
				} else {
					settings.Mode = "durable"
				}
				if settings.ordinaryResumed() {
					t.Fatalf("source bypassed settings %s gate", field)
				}
				original := state[field]
				state[field] = "unsupported"
				if historyOrdinary(state) {
					t.Fatalf("source bypassed history %s gate", field)
				}
				state[field] = original
			}
		})
	}
	if (desktopControlSettings{ResumeState: "resumed", Mode: "default", ThreadSource: json.RawMessage(`invalid`)}).ordinaryResumed() {
		t.Fatal("invalid source JSON accepted")
	}
}

func agentCreatedControlState() map[string]any {
	state := controlState()
	state["threadSource"] = desktopAgentCreatedThreadSource
	return state
}

func agentCreatedControlSettings() map[string]any {
	return map[string]any{"resumeState": "resumed", "mode": "default", "threadSource": desktopAgentCreatedThreadSource}
}

func TestDesktopAgentCreatedReadinessAndSingleOwnerDispatch(t *testing.T) {
	t.Run("readiness-does-not-dispatch", func(t *testing.T) {
		path := desktopFixture(t, func(c *desktopConn) error {
			if err := controlHandshake(c); err != nil {
				return err
			}
			if err := controlPreflight(c, agentCreatedControlState(), agentCreatedControlSettings()); err != nil {
				return err
			}
			return controlExpectClosed(c)
		})
		ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
		defer cancel()
		if err := NewDesktopController(path).CheckSendReadiness(ctx, "session"); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("dispatch-exact-owner-once", func(t *testing.T) {
		var writes atomic.Int32
		path := desktopFixture(t, func(c *desktopConn) error {
			if err := controlHandshake(c); err != nil {
				return err
			}
			for range 2 {
				if err := controlPreflight(c, agentCreatedControlState(), agentCreatedControlSettings()); err != nil {
					return err
				}
			}
			request, err := controlReadDispatch(c)
			if err != nil {
				return err
			}
			writes.Add(1)
			if err := desktopReply(c, request, "owner", map[string]any{"result": map[string]any{"turn": map[string]string{"id": "agent-created-turn"}}}); err != nil {
				return err
			}
			return controlExpectClosed(c)
		})
		ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
		defer cancel()
		prepared, err := NewDesktopController(path).PrepareSend(ctx, controlRequest())
		if err != nil {
			t.Fatal(err)
		}
		defer prepared.Close()
		if turnID, err := prepared.Dispatch(ctx, "prompt"); err != nil || turnID != "agent-created-turn" {
			t.Fatalf("dispatch turn=%q err=%v", turnID, err)
		}
		if _, err := prepared.Dispatch(ctx, "prompt"); err == nil || codex.IsUncertain(err) || writes.Load() != 1 {
			t.Fatalf("duplicate dispatch err=%v writes=%d", err, writes.Load())
		}
	})
}

func TestDesktopAgentCreatedDispatchRechecksGatesBeforeInput(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit func(map[string]any)
		busy bool
	}{
		{"active", func(s map[string]any) { s["threadRuntimeStatus"] = map[string]any{"type": "active"} }, true},
		{"approval", func(s map[string]any) { s["requests"] = []any{map[string]string{"method": "approval"}} }, true},
		{"active-flags", func(s map[string]any) {
			s["threadRuntimeStatus"] = map[string]any{"type": "idle", "activeFlags": []string{"waitingOnApproval"}}
		}, true},
		{"unconfirmed", func(s map[string]any) { s["unconfirmedTurnSubmissions"] = []any{map[string]bool{"pending": true}} }, true},
		{"missing-requests", func(s map[string]any) { delete(s, "requests") }, true},
		{"active-recorded-turn", func(s map[string]any) { s["turns"] = []any{map[string]string{"turnId": "old", "status": "inProgress"}} }, true},
		{"unknown-source", func(s map[string]any) { s["threadSource"] = "future" }, false},
		{"not-resumed", func(s map[string]any) { s["resumeState"] = "needs_resume" }, false},
		{"nondefault-mode", func(s map[string]any) { s["mode"] = "durable" }, false},
		{"nondefault-start", func(s map[string]any) { s["threadStartKind"] = "aeon" }, false},
		{"wrong-target", func(s map[string]any) { s["id"] = "other-session" }, false},
		{"missing-history", func(s map[string]any) { delete(s, "turns") }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := desktopFixture(t, func(c *desktopConn) error {
				if err := controlHandshake(c); err != nil {
					return err
				}
				if err := controlPreflight(c, agentCreatedControlState(), agentCreatedControlSettings()); err != nil {
					return err
				}
				state := agentCreatedControlState()
				tc.edit(state)
				if err := controlPreflight(c, state, agentCreatedControlSettings()); err != nil {
					return err
				}
				return controlExpectClosed(c)
			})
			ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
			defer cancel()
			prepared, err := NewDesktopController(path).PrepareSend(ctx, controlRequest())
			if err != nil {
				t.Fatal(err)
			}
			defer prepared.Close()
			_, err = prepared.Dispatch(ctx, "prompt")
			if err == nil || codex.IsUncertain(err) || errors.Is(err, ErrDesktopSendBusy) != tc.busy {
				t.Fatalf("second preflight err=%v wantBusy=%t", err, tc.busy)
			}
		})
	}
}

func TestDesktopAgentCreatedDispatchRejectsChangedSettingsOrOwner(t *testing.T) {
	for _, kind := range []string{"unknown-source", "wrong-owner"} {
		t.Run(kind, func(t *testing.T) {
			path := desktopFixture(t, func(c *desktopConn) error {
				if err := controlHandshake(c); err != nil {
					return err
				}
				if err := controlPreflight(c, agentCreatedControlState(), agentCreatedControlSettings()); err != nil {
					return err
				}
				request, err := c.read()
				if err != nil {
					return err
				}
				if request.Method != desktopReadSettings || request.TargetClientID != "owner" {
					return errors.New("second settings read did not target original owner")
				}
				settings, owner := agentCreatedControlSettings(), "owner"
				if kind == "unknown-source" {
					settings["threadSource"] = "future"
				} else {
					owner = "other-owner"
				}
				if err := desktopReply(c, request, owner, map[string]any{"settings": settings}); err != nil {
					return err
				}
				return controlExpectClosed(c)
			})
			ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
			defer cancel()
			prepared, err := NewDesktopController(path).PrepareSend(ctx, controlRequest())
			if err != nil {
				t.Fatal(err)
			}
			defer prepared.Close()
			if _, err := prepared.Dispatch(ctx, "prompt"); err == nil || codex.IsUncertain(err) {
				t.Fatalf("changed settings or owner accepted: %v", err)
			}
		})
	}
}
