package codex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestDesktopControlSnapshotEnvelopeFailsClosed(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*desktopEnvelope)
	}{
		{"owner", func(e *desktopEnvelope) { e.SourceClientID = "other-owner" }},
		{"version", func(e *desktopEnvelope) { e.Version = 10 }},
		{"recipient", func(e *desktopEnvelope) { e.TargetClientIDs = []string{"other-client"} }},
		{"missing recipient", func(e *desktopEnvelope) { e.TargetClientIDs = nil }},
		{"target", func(e *desktopEnvelope) {
			e.Params = json.RawMessage(`{"conversationId":"other","hostId":"local","change":{"type":"snapshot"}}`)
		}},
		{"host", func(e *desktopEnvelope) {
			e.Params = json.RawMessage(`{"conversationId":"session","hostId":"remote","change":{"type":"snapshot"}}`)
		}},
		{"invalid JSON", func(e *desktopEnvelope) { e.Params = json.RawMessage(`null`) }},
		{"missing revision", func(e *desktopEnvelope) {
			e.Params = json.RawMessage(`{"conversationId":"session","hostId":"local","change":{"type":"snapshot"}}`)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := desktopFixture(t, func(c *desktopConn) error {
				if err := controlHandshake(c); err != nil {
					return err
				}
				request, err := c.read()
				if err != nil {
					return err
				}
				if err := desktopReply(c, request, "owner", map[string]any{"settings": map[string]string{"mode": "default", "threadSource": "user", "resumeState": "resumed"}}); err != nil {
					return err
				}
				if err := controlSnapshot(c, controlState(), tc.mutate); err != nil {
					return err
				}
				return controlExpectClosed(c)
			})
			ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
			defer cancel()
			p, err := NewDesktopController(path).PrepareSend(ctx, controlRequest())
			if p != nil {
				p.Close()
			}
			if err == nil || IsUncertain(err) {
				t.Fatalf("snapshot failure = %v", err)
			}
		})
	}
}

func TestDesktopControlSettingsFailsClosed(t *testing.T) {
	for _, kind := range []string{"owner", "null settings", "missing settings", "unknown source", "empty source", "aeon source", "unexpected source", "not resumed", "durable"} {
		t.Run(kind, func(t *testing.T) {
			path := desktopFixture(t, func(c *desktopConn) error {
				if err := controlHandshake(c); err != nil {
					return err
				}
				request, err := c.read()
				if err != nil {
					return err
				}
				owner := "owner"
				settings := map[string]string{"mode": "default", "threadSource": "user", "resumeState": "resumed"}
				result := map[string]any{"settings": settings}
				switch kind {
				case "owner":
					owner = "other-owner"
				case "null settings":
					result["settings"] = nil
				case "missing settings":
					delete(result, "settings")
				case "unknown source":
					delete(settings, "threadSource")
				case "empty source":
					settings["threadSource"] = ""
				case "aeon source":
					settings["threadSource"] = "aeon"
				case "unexpected source":
					settings["threadSource"] = "future"
				case "not resumed":
					settings["resumeState"] = "needs_resume"
				case "durable":
					settings["mode"] = "durable"
				}
				if err := desktopReply(c, request, owner, result); err != nil {
					return err
				}
				return controlExpectClosed(c)
			})
			ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
			defer cancel()
			p, err := NewDesktopController(path).PrepareSend(ctx, controlRequest())
			if p != nil {
				p.Close()
			}
			if err == nil || IsUncertain(err) {
				t.Fatalf("settings failure = %v", err)
			}
		})
	}
}

func TestDesktopControlExplicitNullSourceUsesNativeUserDefault(t *testing.T) {
	path := desktopFixture(t, func(c *desktopConn) error {
		if err := controlHandshake(c); err != nil {
			return err
		}
		for range 2 {
			state := controlState()
			state["threadSource"] = nil
			settings := map[string]any{"mode": "default", "threadSource": nil, "resumeState": "resumed"}
			if err := controlPreflight(c, state, settings); err != nil {
				return err
			}
		}
		request, err := controlReadDispatch(c)
		if err != nil {
			return err
		}
		return desktopReply(c, request, "owner", map[string]any{"result": map[string]any{"turn": map[string]string{"id": "target"}}})
	})
	ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
	defer cancel()
	p, err := NewDesktopController(path).PrepareSend(ctx, controlRequest())
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if turn, err := p.Dispatch(ctx, "prompt"); err != nil || turn != "target" {
		t.Fatalf("explicit native null source = %q,%v", turn, err)
	}
}

func TestDesktopControlCanonicalOutputUsesAgentMessageTextOnly(t *testing.T) {
	state := controlState()
	turn := map[string]any{"turnId": "target", "status": "completed", "items": []any{
		map[string]string{"type": "reasoning", "text": "private reasoning"},
		map[string]string{"type": "plan", "text": "not an answer"},
		map[string]string{"type": "agentMessage", "text": "first answer"},
		map[string]string{"type": "commandExecution", "text": "tool output"},
		map[string]string{"type": "agentMessage", "text": "final answer"},
	}}
	state["turnHistory"] = map[string]any{"kind": "canonical", "history": map[string]any{"islands": []any{map[string]any{"entries": []any{map[string]string{"value": "entity"}}}}, "entitiesByKey": map[string]any{"entity": turn}}}
	path := desktopFixture(t, func(c *desktopConn) error {
		if err := controlHandshake(c); err != nil {
			return err
		}
		return controlSnapshot(c, state, nil)
	})
	ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
	defer cancel()
	result, err := NewDesktopController(path).InspectTurn(ctx, "session", "target")
	if err != nil || result.Status != "completed" || result.Output != "first answer\n\nfinal answer" {
		t.Fatalf("canonical output = %+v, %v", result, err)
	}
}

func TestDesktopControlAckTimeoutAndBadShapeAreUncertain(t *testing.T) {
	for _, kind := range []string{"timeout", "wrong request ID", "malformed result", "outer ID only"} {
		t.Run(kind, func(t *testing.T) {
			path := desktopFixture(t, func(c *desktopConn) error {
				if err := controlHandshake(c); err != nil {
					return err
				}
				for range 2 {
					if err := controlPreflight(c, controlState(), nil); err != nil {
						return err
					}
				}
				request, err := controlReadDispatch(c)
				if err != nil {
					return err
				}
				if kind == "timeout" {
					return controlExpectClosed(c)
				}
				if kind == "wrong request ID" {
					request.RequestID = controlMessageID
				}
				result := any(map[string]any{"result": map[string]any{"turn": map[string]string{"id": "target"}}})
				if kind == "malformed result" {
					result = "unusable"
				}
				if kind == "outer ID only" {
					result = map[string]string{"id": "not-a-turn"}
				}
				if err := desktopReply(c, request, "owner", result); err != nil {
					return err
				}
				return controlExpectClosed(c)
			})
			ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
			defer cancel()
			p, err := NewDesktopController(path).PrepareSend(ctx, controlRequest())
			if err != nil {
				t.Fatal(err)
			}
			defer p.Close()
			dispatchCtx, dispatchCancel := context.WithTimeout(ctx, 150*time.Millisecond)
			defer dispatchCancel()
			if _, err := p.Dispatch(dispatchCtx, "prompt"); !IsUncertain(err) {
				t.Fatalf("ack error = %v", err)
			}
			p.Close()
		})
	}
}

func TestDesktopControlConcurrentDispatchOnlyOnce(t *testing.T) {
	ready, release := make(chan struct{}), make(chan struct{})
	path := desktopFixture(t, func(c *desktopConn) error {
		if err := controlHandshake(c); err != nil {
			return err
		}
		for range 2 {
			if err := controlPreflight(c, controlState(), nil); err != nil {
				return err
			}
		}
		request, err := controlReadDispatch(c)
		if err != nil {
			return err
		}
		close(ready)
		select {
		case <-release:
		case <-time.After(desktopTestTimeout):
			return errors.New("test release timed out")
		}
		if err := desktopReply(c, request, "owner", map[string]any{"result": map[string]any{"turn": map[string]string{"id": "target"}}}); err != nil {
			return err
		}
		return controlExpectClosed(c)
	})
	ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
	defer cancel()
	p, err := NewDesktopController(path).PrepareSend(ctx, controlRequest())
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	done := make(chan error, 1)
	go func() { _, err := p.Dispatch(ctx, "prompt"); done <- err }()
	select {
	case <-ready:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	_, duplicateErr := p.Dispatch(ctx, "prompt")
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if duplicateErr == nil || IsUncertain(duplicateErr) {
		t.Fatalf("concurrent duplicate = %v", duplicateErr)
	}
}

func TestDesktopControlInvalidPromptAndIdentityDoNotWrite(t *testing.T) {
	for _, req := range []DesktopSendRequest{{SessionID: "session"}, {SessionID: "session", ClientUserMessageID: "invalid", RequestID: controlRequestID}, {SessionID: " session", ClientUserMessageID: controlMessageID, RequestID: controlRequestID}} {
		if _, err := NewDesktopController("not-a-socket").PrepareSend(context.Background(), req); err == nil {
			t.Fatal("invalid identity accepted")
		}
	}
	for _, prompt := range []string{" ", string([]byte{0xff}), strings.Repeat("p", protocol.MaxControllerMessageBytes+1)} {
		t.Run(fmt.Sprintf("size=%d", len(prompt)), func(t *testing.T) {
			path := desktopFixture(t, func(c *desktopConn) error {
				if err := controlHandshake(c); err != nil {
					return err
				}
				if err := controlPreflight(c, controlState(), nil); err != nil {
					return err
				}
				return controlExpectClosed(c)
			})
			ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
			defer cancel()
			p, err := NewDesktopController(path).PrepareSend(ctx, controlRequest())
			if err != nil {
				t.Fatal(err)
			}
			defer p.Close()
			if _, err := p.Dispatch(ctx, prompt); err == nil || IsUncertain(err) {
				t.Fatalf("invalid prompt = %v", err)
			}
		})
	}
}

func TestDesktopControlExactTurnConflictAndMissingCanonicalEntity(t *testing.T) {
	for _, missing := range []bool{false, true} {
		t.Run(fmt.Sprintf("missing=%v", missing), func(t *testing.T) {
			state := controlState()
			turn := map[string]any{"turnId": "target", "status": "completed", "items": []any{}}
			entities := map[string]any{"entity": turn}
			if missing {
				delete(entities, "entity")
			} else {
				state["turns"] = []any{map[string]any{"turnId": "target", "status": "inProgress", "items": []any{}}}
			}
			state["turnHistory"] = map[string]any{"kind": "canonical", "history": map[string]any{"islands": []any{map[string]any{"entries": []any{map[string]string{"value": "entity"}}}}, "entitiesByKey": entities}}
			path := desktopFixture(t, func(c *desktopConn) error {
				if err := controlHandshake(c); err != nil {
					return err
				}
				return controlSnapshot(c, state, nil)
			})
			ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
			defer cancel()
			if _, err := NewDesktopController(path).InspectTurn(ctx, "session", "target"); err == nil {
				t.Fatal("conflicting or missing turn accepted")
			}
		})
	}
}
