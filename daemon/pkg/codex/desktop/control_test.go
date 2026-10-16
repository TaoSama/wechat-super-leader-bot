package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	controlMessageID = "01234567-89ab-4cde-8123-456789abcdef"
	controlRequestID = "fedcba98-7654-4321-8123-456789abcdef"
)

func controlRequest() DesktopSendRequest {
	return DesktopSendRequest{SessionID: "session", ClientUserMessageID: controlMessageID, RequestID: controlRequestID}
}

func controlHandshake(c *desktopConn) error {
	request, err := c.read()
	if err != nil {
		return err
	}
	var params map[string]string
	if err := json.Unmarshal(request.Params, &params); err != nil {
		return err
	}
	if request.Type != "request" || request.Method != desktopInitialize || request.Version != 0 || request.SourceClientID != "initializing-client" || params["clientType"] != desktopControlClient {
		return errors.New("invalid controller initialize")
	}
	if err := desktopReply(c, request, "control-client", map[string]string{"clientId": "control-client"}); err != nil {
		return err
	}
	request, err = c.read()
	if err != nil {
		return err
	}
	if err := json.Unmarshal(request.Params, &params); err != nil {
		return err
	}
	if request.Method != desktopDiscoverOwner || request.Version != 1 || params["conversationId"] != "session" || params["hostId"] != "local" {
		return errors.New("invalid controller discovery")
	}
	return desktopReply(c, request, "owner", map[string]bool{"supportsUntrustedAppInput": true})
}

func controlState() map[string]any {
	return map[string]any{"id": "session", "hostId": "local", "mode": "default", "threadSource": "user", "threadStartKind": "default", "resumeState": "resumed",
		"threadRuntimeStatus": map[string]any{"type": "idle", "activeFlags": []string{}}, "requests": []any{}, "turns": []any{}}
}

func controlSnapshot(c *desktopConn, state map[string]any, mutate func(*desktopEnvelope)) error {
	follow, err := c.read()
	if err != nil {
		return err
	}
	var params map[string]any
	if err := json.Unmarshal(follow.Params, &params); err != nil {
		return err
	}
	if follow.Type != "broadcast" || follow.Method != desktopFollowingChanged || len(follow.TargetClientIDs) != 1 || follow.TargetClientIDs[0] != "owner" || params["conversationId"] != "session" || params["following"] != true {
		return errors.New("invalid controller subscription")
	}
	data, err := json.Marshal(map[string]any{"conversationId": "session", "hostId": "local", "change": map[string]any{"type": "snapshot", "revision": 1, "conversationState": state}})
	if err != nil {
		return err
	}
	envelope := desktopEnvelope{Type: "broadcast", Method: desktopStateChanged, Version: 11, SourceClientID: "owner", TargetClientIDs: []string{"control-client"}, Params: data}
	if mutate != nil {
		mutate(&envelope)
	}
	return c.write(envelope)
}

func controlPreflight(c *desktopConn, state map[string]any, settings map[string]any) error {
	request, err := c.read()
	if err != nil {
		return err
	}
	var params map[string]string
	if err := json.Unmarshal(request.Params, &params); err != nil {
		return err
	}
	if request.Method != desktopReadSettings || request.Version != 1 || request.TargetClientID != "owner" || request.SourceClientID != "control-client" || params["conversationId"] != "session" || len(params) != 1 {
		return errors.New("invalid exact settings request")
	}
	if settings == nil {
		settings = map[string]any{"mode": "default", "threadSource": "user", "resumeState": "resumed"}
	}
	if err := desktopReply(c, request, "owner", map[string]any{"settings": settings}); err != nil {
		return err
	}
	return controlSnapshot(c, state, nil)
}

func controlExpectClosed(c *desktopConn) error {
	_, err := c.read()
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err != nil {
		return err
	}
	return errors.New("unexpected extra control write")
}

func controlReadDispatch(c *desktopConn) (desktopEnvelope, error) {
	request, err := c.read()
	if err != nil {
		return request, err
	}
	var params struct {
		ConversationID string `json:"conversationId"`
		TurnStart      struct {
			Request struct {
				ThreadID            string `json:"threadId"`
				ClientUserMessageID string `json:"clientUserMessageId"`
				Input               []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"input"`
			} `json:"request"`
			Context struct {
				Inherit   bool `json:"inheritThreadSettings"`
				Admission bool `json:"useUserMessageAdmission"`
			} `json:"context"`
		} `json:"turnStart"`
	}
	if err := json.Unmarshal(request.Params, &params); err != nil {
		return request, err
	}
	if request.Type != "request" || request.Method != desktopStartTurn || request.Version != 2 || request.RequestID != controlRequestID || request.TargetClientID != "owner" || request.SourceClientID != "control-client" || params.ConversationID != "session" || params.TurnStart.Request.ThreadID != "session" || params.TurnStart.Request.ClientUserMessageID != controlMessageID || len(params.TurnStart.Request.Input) != 1 || params.TurnStart.Request.Input[0].Text != "prompt" || !params.TurnStart.Context.Inherit || params.TurnStart.Context.Admission {
		return request, fmt.Errorf("wrong exact desktop dispatch: %+v", request)
	}
	return request, nil
}

func TestDesktopControlDispatchExactIdentityAndOnce(t *testing.T) {
	var writes atomic.Int32
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
		writes.Add(1)
		if err := desktopReply(c, request, "owner", map[string]any{"result": map[string]any{"turn": map[string]string{"id": "native-target"}}}); err != nil {
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
	identity := p.Identity()
	if identity.Route != protocol.RouteDesktopOwner || identity.SessionID != "session" || identity.ConnectionID != "control-client" || identity.OwnerID != "owner" || identity.Endpoint != path || identity.RequestID != controlRequestID || identity.ClientUserMessageID != controlMessageID {
		t.Fatalf("identity = %+v", identity)
	}
	turn, err := p.Dispatch(ctx, "prompt")
	if err != nil || turn != "native-target" {
		t.Fatalf("dispatch = %q, %v", turn, err)
	}
	if _, err := p.Dispatch(ctx, "prompt"); err == nil || codex.IsUncertain(err) || writes.Load() != 1 {
		t.Fatalf("duplicate = %v, writes = %d", err, writes.Load())
	}
}

func TestDesktopControlPreflightFailsClosed(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(map[string]any)
	}{
		{"busy", func(s map[string]any) { s["threadRuntimeStatus"] = map[string]any{"type": "active"} }},
		{"approval", func(s map[string]any) {
			s["threadRuntimeStatus"] = map[string]any{"type": "idle", "activeFlags": []string{"waitingOnApproval"}}
		}},
		{"requests", func(s map[string]any) {
			s["requests"] = []any{map[string]string{"method": "item/commandExecution/requestApproval"}}
		}},
		{"missing requests", func(s map[string]any) { delete(s, "requests") }},
		{"unconfirmed", func(s map[string]any) { s["unconfirmedTurnSubmissions"] = []any{map[string]bool{"terminal": true}} }},
		{"aeon source", func(s map[string]any) { s["threadSource"] = "aeon" }},
		{"aeon start", func(s map[string]any) { s["threadStartKind"] = "aeon" }},
		{"unknown mode", func(s map[string]any) { delete(s, "mode") }},
		{"missing source", func(s map[string]any) { delete(s, "threadSource") }},
		{"empty source", func(s map[string]any) { s["threadSource"] = "" }},
		{"unknown source", func(s map[string]any) { s["threadSource"] = "future" }},
		{"unknown start", func(s map[string]any) { s["threadStartKind"] = "future" }},
		{"durable", func(s map[string]any) { s["mode"] = "durable" }},
		{"not resumed", func(s map[string]any) { s["resumeState"] = "needs_resume" }},
		{"wrong target", func(s map[string]any) { s["id"] = "another-session" }},
		{"wrong host", func(s map[string]any) { s["hostId"] = "remote" }},
		{"active turn", func(s map[string]any) {
			s["turns"] = []any{map[string]string{"turnId": "older", "status": "inProgress"}}
		}},
		{"unknown history", func(s map[string]any) { s["turnHistory"] = map[string]string{"kind": "future"} }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state := controlState()
			tc.change(state)
			path := desktopFixture(t, func(c *desktopConn) error {
				if err := controlHandshake(c); err != nil {
					return err
				}
				if err := controlPreflight(c, state, nil); err != nil {
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
			if err == nil || codex.IsUncertain(err) {
				t.Fatalf("preflight = %v", err)
			}
		})
	}
}

func TestDesktopControlWriteFailuresAreUncertain(t *testing.T) {
	for _, kind := range []string{"disconnect", "missing ID", "bad ID", "wrong owner", "wrong method", "error"} {
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
				if kind == "disconnect" {
					return nil
				}
				owner, id := "owner", "target"
				if kind == "missing ID" {
					id = ""
				}
				if kind == "bad ID" {
					id = " target "
				}
				if kind == "wrong owner" {
					owner = "other"
				}
				if kind == "wrong method" {
					request.Method = "other"
				}
				if kind == "error" {
					return c.write(desktopEnvelope{Type: "response", RequestID: request.RequestID, ResultType: "error"})
				}
				return desktopReply(c, request, owner, map[string]any{"result": map[string]any{"turn": map[string]string{"id": id}}})
			})
			ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
			defer cancel()
			p, err := NewDesktopController(path).PrepareSend(ctx, controlRequest())
			if err != nil {
				t.Fatal(err)
			}
			defer p.Close()
			if _, err := p.Dispatch(ctx, "prompt"); !codex.IsUncertain(err) {
				t.Fatalf("dispatch error = %v", err)
			}
			if _, err := p.Dispatch(ctx, "prompt"); err == nil {
				t.Fatal("retry was allowed")
			}
		})
	}
}

func TestDesktopControlRechecksBusyBeforeDispatch(t *testing.T) {
	path := desktopFixture(t, func(c *desktopConn) error {
		if err := controlHandshake(c); err != nil {
			return err
		}
		if err := controlPreflight(c, controlState(), nil); err != nil {
			return err
		}
		state := controlState()
		state["requests"] = []any{map[string]string{"method": "approval"}}
		if err := controlPreflight(c, state, nil); err != nil {
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
	if _, err := p.Dispatch(ctx, "prompt"); err == nil || codex.IsUncertain(err) {
		t.Fatalf("busy dispatch = %v", err)
	}
}

func TestDesktopControlPrepareContextLifetime(t *testing.T) {
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
	p, err := NewDesktopController(path).PrepareSend(ctx, controlRequest())
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	defer p.Close()
	cancel()
	if _, err := p.Dispatch(context.Background(), "prompt"); !errors.Is(err, context.Canceled) {
		t.Fatalf("expired preparation = %v", err)
	}
}

func TestDesktopControlInspectionExactTurn(t *testing.T) {
	for _, canonical := range []bool{false, true} {
		for _, status := range []string{"inProgress", "completed", "failed", "interrupted", "unknown", "missing"} {
			t.Run(fmt.Sprintf("canonical=%v/%s", canonical, status), func(t *testing.T) {
				state := controlState()
				turn := map[string]any{"turnId": "target", "status": status, "items": []any{map[string]string{"type": "agentMessage", "text": "exact output"}}}
				if status == "missing" {
					turn["turnId"] = "not-target"
				}
				if canonical {
					state["turnHistory"] = map[string]any{"kind": "canonical", "history": map[string]any{"islands": []any{map[string]any{"entries": []any{map[string]string{"value": "entity"}}}}, "entitiesByKey": map[string]any{"entity": turn}}}
				} else {
					state["turns"] = []any{turn}
				}
				path := desktopFixture(t, func(c *desktopConn) error {
					if err := controlHandshake(c); err != nil {
						return err
					}
					return controlSnapshot(c, state, nil)
				})
				ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
				defer cancel()
				result, err := NewDesktopController(path).InspectTurn(ctx, "session", "target")
				if status == "unknown" || status == "missing" {
					if err == nil {
						t.Fatalf("wrong completion %+v", result)
					}
					return
				}
				if err != nil || result.Status != status || result.Output != "exact output" {
					t.Fatalf("exact turn = %+v, %v", result, err)
				}
			})
		}
	}
}

func TestDesktopControlInspectionRejectsWrongOwner(t *testing.T) {
	path := desktopFixture(t, func(c *desktopConn) error {
		if err := controlHandshake(c); err != nil {
			return err
		}
		return controlSnapshot(c, controlState(), func(e *desktopEnvelope) { e.SourceClientID = "other-owner" })
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := NewDesktopController(path).InspectTurn(ctx, "session", "target"); err == nil {
		t.Fatal("wrong owner accepted")
	}
}
