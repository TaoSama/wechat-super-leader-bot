package appserver

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/gorilla/websocket"
)

const (
	startFixtureSession       = "start-rejection-session"
	startFixtureTurn          = "start-rejection-turn"
	startFixturePrompt        = "continue the requested work"
	startFixtureTimeout       = 3 * time.Second
	startFixtureRPCWait       = 100 * time.Millisecond
	startFixtureReason        = "invalid params; no turn started"
	startFixtureInvalidParams = -32602
	startFixtureMissingMethod = -32601
	startFixtureInternalError = -32603
	startFixtureServerError   = -32000
	startFixtureAppError      = 1
)

type startAcknowledgementCase struct {
	mode      string
	error     any
	hasResult bool
	wantError bool
	uncertain bool
}

// The server observes turn/start before dropping or withholding its response,
// so lost acknowledgements exercise an unknown mutation outcome.
func startAcknowledgementServer(t *testing.T, tc startAcknowledgementCase, starts, connections *atomic.Int32) *AppServerAdapter {
	t.Helper()
	directory, err := os.MkdirTemp("/tmp", "start-ack-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(directory); err != nil {
			t.Errorf("remove start fixture directory: %v", err)
		}
	})
	listener, err := net.Listen("unix", filepath.Join(directory, "app.sock"))
	if err != nil {
		t.Fatal(err)
	}
	var handlers sync.WaitGroup
	upgrader := websocket.Upgrader{}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handlers.Add(1)
		defer handlers.Done()
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade start fixture connection: %v", err)
			return
		}
		connections.Add(1)
		defer func() {
			if err := conn.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
				t.Errorf("close start fixture connection: %v", err)
			}
		}()
		if err := conn.SetReadDeadline(time.Now().Add(startFixtureTimeout)); err != nil {
			t.Errorf("set start fixture read deadline: %v", err)
			return
		}
		for {
			var request steerRequest
			if err := conn.ReadJSON(&request); err != nil {
				var closed *websocket.CloseError
				if !errors.As(err, &closed) && !errors.Is(err, net.ErrClosed) {
					t.Errorf("read start fixture request: %v", err)
				}
				return
			}
			result := map[string]any{}
			message := map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result}
			switch request.Method {
			case "initialize":
			case "initialized":
				continue
			case "thread/loaded/list":
				result["data"] = []string{startFixtureSession}
			case "thread/read":
				result["thread"] = map[string]any{"id": startFixtureSession, "status": map[string]any{"type": "idle"}}
			case "turn/start":
				starts.Add(1)
				want := map[string]any{"threadId": startFixtureSession, "input": []any{map[string]any{"type": "text", "text": startFixturePrompt}}}
				if !reflect.DeepEqual(request.Params, want) {
					t.Errorf("turn/start params=%#v, want %#v", request.Params, want)
					return
				}
				switch tc.mode {
				case "disconnect":
					return
				case "timeout":
					continue
				case "invalid-ack":
					result["turn"] = map[string]any{"id": "invalid turn"}
				case "missing-ack":
				default:
					result["turn"] = map[string]any{"id": startFixtureTurn}
				}
				if tc.error != nil {
					if !tc.hasResult {
						delete(message, "result")
					}
					message["error"] = tc.error
				}
			default:
				t.Errorf("unexpected RPC %q", request.Method)
				return
			}
			if err := conn.WriteJSON(message); err != nil {
				t.Errorf("write start fixture response: %v", err)
				return
			}
		}
	}))
	server.Listener = listener
	server.Start()
	t.Cleanup(func() {
		server.Close()
		handlers.Wait()
	})
	adapter := NewAppServerAdapter(listener.Addr().String())
	adapter.rpcTimeout = startFixtureRPCWait
	return adapter
}

func TestStartTurnDefiniteRejectionAndUnknownAcknowledgements(t *testing.T) {
	for _, route := range []string{"send", "resume-send"} {
		for _, tc := range []startAcknowledgementCase{
			{mode: "invalid-params", error: map[string]any{"code": startFixtureInvalidParams, "message": startFixtureReason}, wantError: true},
			{mode: "method-not-found", error: map[string]any{"code": startFixtureMissingMethod, "message": startFixtureReason}, wantError: true},
			{mode: "internal-error", error: map[string]any{"code": startFixtureInternalError, "message": startFixtureReason}, wantError: true, uncertain: true},
			{mode: "server-error", error: map[string]any{"code": startFixtureServerError, "message": startFixtureReason}, wantError: true, uncertain: true},
			{mode: "application-error", error: map[string]any{"code": startFixtureAppError, "message": startFixtureReason}, wantError: true, uncertain: true},
			{mode: "missing-code", error: map[string]any{"message": startFixtureReason}, wantError: true, uncertain: true},
			{mode: "missing-message", error: map[string]any{"code": startFixtureInvalidParams}, wantError: true, uncertain: true},
			{mode: "string-code", error: map[string]any{"code": "-32602", "message": startFixtureReason}, wantError: true, uncertain: true},
			{mode: "malformed-error", error: startFixtureReason, wantError: true, uncertain: true},
			{mode: "conflicting-result", error: map[string]any{"code": startFixtureInvalidParams, "message": startFixtureReason}, hasResult: true, wantError: true, uncertain: true},
			{mode: "disconnect", wantError: true, uncertain: true},
			{mode: "timeout", wantError: true, uncertain: true},
			{mode: "invalid-ack", wantError: true, uncertain: true},
			{mode: "missing-ack", wantError: true, uncertain: true},
			{mode: "accepted"},
		} {
			t.Run(route+"/"+tc.mode, func(t *testing.T) {
				var starts, connections atomic.Int32
				adapter := startAcknowledgementServer(t, tc, &starts, &connections)
				ctx, cancel := context.WithTimeout(context.Background(), startFixtureTimeout)
				defer cancel()
				var result string
				var err error
				if route == "send" {
					result, err = adapter.SendPrompt(ctx, startFixtureSession, startFixturePrompt)
				} else {
					result, err = adapter.ResumeSend(ctx, startFixtureSession, startFixturePrompt)
				}
				if (err != nil) != tc.wantError || codex.IsUncertain(err) != tc.uncertain {
					t.Fatalf("result=%q err=%v uncertain=%t; want error=%t uncertain=%t", result, err, codex.IsUncertain(err), tc.wantError, tc.uncertain)
				}
				if err != nil && result != "" || err == nil && !strings.Contains(result, startFixtureTurn) {
					t.Fatalf("unexpected accepted turn: result=%q err=%v", result, err)
				}
				if tc.error != nil && tc.mode != "missing-message" && !strings.Contains(err.Error(), startFixtureReason) {
					t.Fatalf("native rejection reason lost: %v", err)
				}
				if starts.Load() != 1 || connections.Load() != 1 {
					t.Fatalf("turn/start calls=%d connections=%d, want one attempt without retry", starts.Load(), connections.Load())
				}
			})
		}
	}
}

func TestRPCRejectionRequiresDefinitePreExecutionError(t *testing.T) {
	for _, tc := range []struct {
		name      string
		value     any
		hasResult bool
		definite  bool
	}{
		{name: "parse", value: map[string]any{"code": rpcParseError, "message": startFixtureReason}, definite: true},
		{name: "request", value: map[string]any{"code": rpcInvalidRequest, "message": startFixtureReason}, definite: true},
		{name: "method", value: map[string]any{"code": rpcMethodNotFound, "message": startFixtureReason}, definite: true},
		{name: "params", value: map[string]any{"code": rpcInvalidParams, "message": startFixtureReason}, definite: true},
		{name: "internal", value: map[string]any{"code": startFixtureInternalError, "message": startFixtureReason}},
		{name: "server", value: map[string]any{"code": startFixtureServerError, "message": startFixtureReason}},
		{name: "application", value: map[string]any{"code": startFixtureAppError, "message": startFixtureReason}},
		{name: "missing-code", value: map[string]any{"message": startFixtureReason}},
		{name: "missing-message", value: map[string]any{"code": rpcMethodNotFound}},
		{name: "fractional-code", value: map[string]any{"code": -32601.5, "message": startFixtureReason}},
		{name: "string-code", value: map[string]any{"code": "-32601", "message": startFixtureReason}},
		{name: "malformed-error", value: startFixtureReason},
		{name: "conflicting-result", value: map[string]any{"code": rpcMethodNotFound, "message": startFixtureReason}, hasResult: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := newRPCRejectedError(tc.value, tc.hasResult)
			if err.beforeExecution != tc.definite {
				t.Fatalf("beforeExecution=%t, want %t: %v", err.beforeExecution, tc.definite, err)
			}
		})
	}
}
