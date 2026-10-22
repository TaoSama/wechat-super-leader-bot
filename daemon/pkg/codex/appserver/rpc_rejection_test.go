package appserver

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/gorilla/websocket"
)

const (
	startFixtureSession = "start-rejection-session"
	startFixtureTurn    = "start-rejection-turn"
	startFixturePrompt  = "continue the requested work"
	startFixtureTimeout = 3 * time.Second
	startFixtureRPCWait = 100 * time.Millisecond
	startFixtureReason  = "request was rejected"
)

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
		{name: "internal", value: map[string]any{"code": -32603, "message": startFixtureReason}},
		{name: "server", value: map[string]any{"code": -32000, "message": startFixtureReason}},
		{name: "application", value: map[string]any{"code": 1, "message": startFixtureReason}},
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

// The synthetic server observes turn/start before dropping or withholding its
// response, distinguishing an unknown mutation outcome from a preflight error.
func startAcknowledgementServer(t *testing.T, mode string, starts *atomic.Int32) *AppServerAdapter {
	t.Helper()
	directory, err := os.MkdirTemp("/tmp", "start-ack-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(directory); err != nil {
			t.Error(err)
		}
	})
	listener, err := net.Listen("unix", filepath.Join(directory, "app.sock"))
	if err != nil {
		t.Fatal(err)
	}
	upgrader := websocket.Upgrader{}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer func() {
			if err := conn.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
				t.Error(err)
			}
		}()
		if err := conn.SetReadDeadline(time.Now().Add(startFixtureTimeout)); err != nil {
			t.Error(err)
			return
		}
		for {
			var request steerRequest
			if err := conn.ReadJSON(&request); err != nil {
				return
			}
			result := map[string]any{}
			message := map[string]any{"id": request.ID, "result": result}
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
				switch mode {
				case "disconnect":
					return
				case "timeout":
					continue
				case "rejected", "internal-error":
					code := rpcMethodNotFound
					if mode == "internal-error" {
						code = -32603
					}
					delete(message, "result")
					message["error"] = map[string]any{"code": code, "message": startFixtureReason}
				case "invalid-ack":
					result["turn"] = map[string]any{"id": "invalid turn"}
				case "accepted":
					result["turn"] = map[string]any{"id": startFixtureTurn}
				default:
					t.Errorf("unknown acknowledgement mode %q", mode)
					return
				}
			default:
				t.Errorf("unexpected RPC %q", request.Method)
				return
			}
			if err := conn.WriteJSON(message); err != nil {
				t.Error(err)
				return
			}
		}
	}))
	server.Listener = listener
	server.Start()
	t.Cleanup(server.Close)
	adapter := NewAppServerAdapter(listener.Addr().String())
	adapter.rpcTimeout = startFixtureRPCWait
	return adapter
}

func TestStartTurnDefiniteRejectionAndUnknownAcknowledgements(t *testing.T) {
	for _, route := range []string{"send", "resume-send"} {
		for _, tc := range []struct {
			mode      string
			wantError bool
			uncertain bool
		}{
			{mode: "rejected", wantError: true},
			{mode: "internal-error", wantError: true, uncertain: true},
			{mode: "disconnect", wantError: true, uncertain: true},
			{mode: "timeout", wantError: true, uncertain: true},
			{mode: "invalid-ack", wantError: true, uncertain: true},
			{mode: "accepted"},
		} {
			t.Run(route+"/"+tc.mode, func(t *testing.T) {
				var starts atomic.Int32
				adapter := startAcknowledgementServer(t, tc.mode, &starts)
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
				if tc.mode == "rejected" && !strings.Contains(err.Error(), startFixtureReason) {
					t.Fatalf("native rejection reason lost: %v", err)
				}
				if starts.Load() != 1 {
					t.Fatalf("turn/start calls=%d, want one attempt", starts.Load())
				}
			})
		}
	}
}
