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
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/gorilla/websocket"
)

const (
	steerFixtureTimeout = 3 * time.Second
	steerRPCTimeout     = 100 * time.Millisecond
	steerSessionID      = "fixture-session"
	steerTurnID         = "exact-active-turn"
	steerPrompt         = "请保留这个输入的原始内容。\nContinue the active work."
	steerRejection      = "expectedTurnId does not match the active turn"
)

type steerRequest struct {
	ID     any            `json:"id"`
	Method string         `json:"method"`
	Params map[string]any `json:"params"`
}

type steerFixture struct {
	connections atomic.Int32
	steers      atomic.Int32
	fallbacks   atomic.Int32
	ackMode     string
	result      map[string]any
}

func newSteerFixture(t *testing.T, fixture *steerFixture) string {
	t.Helper()
	// A short path avoids the macOS Unix socket path length limit.
	dir, err := os.MkdirTemp("/tmp", "codex-steer-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(dir); err != nil {
			t.Errorf("remove fixture directory: %v", err)
		}
	})
	socket := filepath.Join(dir, "app.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	connections := make(map[*websocket.Conn]bool)
	var handlers sync.WaitGroup
	upgrader := websocket.Upgrader{}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handlers.Add(1)
		defer handlers.Done()
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade fixture connection: %v", err)
			return
		}
		fixture.connections.Add(1)
		mu.Lock()
		connections[conn] = true
		mu.Unlock()
		defer func() {
			mu.Lock()
			delete(connections, conn)
			mu.Unlock()
			if err := conn.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
				t.Errorf("close fixture connection: %v", err)
			}
		}()
		if err := conn.SetReadDeadline(time.Now().Add(steerFixtureTimeout)); err != nil {
			t.Errorf("set fixture deadline: %v", err)
			return
		}
		fixture.serve(t, conn)
	}))
	server.Listener = listener
	server.Start()
	t.Cleanup(func() {
		server.Close()
		mu.Lock()
		for conn := range connections {
			if err := conn.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
				t.Errorf("stop fixture connection: %v", err)
			}
		}
		mu.Unlock()
		joined := make(chan struct{})
		go func() { handlers.Wait(); close(joined) }()
		select {
		case <-joined:
		case <-time.After(steerFixtureTimeout):
			t.Error("steer fixture handlers did not stop")
		}
	})
	return socket
}

func (f *steerFixture) serve(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	for {
		var request steerRequest
		if err := conn.ReadJSON(&request); err != nil {
			return // The adapter closes after each operation, including lost acknowledgements.
		}
		result := map[string]any{}
		switch request.Method {
		case "initialize":
		case "initialized":
			continue
		case "thread/loaded/list":
			result = map[string]any{"data": []string{steerSessionID}, "nextCursor": nil}
		case "thread/read":
			if request.Params["threadId"] != steerSessionID || request.Params["includeTurns"] == true {
				t.Errorf("steer preflight changed target or requested recorded bodies: %#v", request.Params)
				return
			}
			result = map[string]any{"thread": map[string]any{"id": steerSessionID, "status": map[string]any{"type": "active"}}}
		case "turn/steer":
			f.steers.Add(1)
			want := map[string]any{
				"threadId": steerSessionID, "expectedTurnId": steerTurnID,
				"input": []any{map[string]any{"type": "text", "text": steerPrompt}},
			}
			if !reflect.DeepEqual(request.Params, want) {
				t.Errorf("turn/steer parameters = %#v, want %#v", request.Params, want)
				return
			}
			switch f.ackMode {
			case "disconnect":
				return
			case "timeout":
				continue
			case "reject":
				if err := conn.WriteJSON(map[string]any{"jsonrpc": "2.0", "id": request.ID,
					"error": map[string]any{"code": -32000, "message": steerRejection}}); err != nil {
					t.Errorf("write native rejection: %v", err)
					return
				}
				continue
			}
			result = f.result
		case "turn/start", "thread/resume", "thread/start":
			f.fallbacks.Add(1)
			t.Errorf("steer attempted fallback mutation %q", request.Method)
			return
		default:
			t.Errorf("unexpected steer RPC %q", request.Method)
			return
		}
		if err := conn.WriteJSON(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result}); err != nil {
			t.Errorf("write fixture response: %v", err)
			return
		}
	}
}

func TestSteerPromptNativeProtocolAndNoFallback(t *testing.T) {
	for _, tc := range []struct {
		name      string
		ackMode   string
		result    map[string]any
		wantError bool
		uncertain bool
	}{
		{name: "active-exact-native-turn", result: map[string]any{"turnId": steerTurnID}},
		{name: "native-rejection", ackMode: "reject", wantError: true},
		{name: "lost-ack-connection", ackMode: "disconnect", wantError: true, uncertain: true},
		{name: "lost-ack-timeout", ackMode: "timeout", wantError: true, uncertain: true},
		{name: "mismatched-turn", result: map[string]any{"turnId": "other-valid-turn"}, wantError: true, uncertain: true},
		{name: "invalid-turn", result: map[string]any{"turnId": "bad turn"}, wantError: true, uncertain: true},
		{name: "missing-turn", result: map[string]any{}, wantError: true, uncertain: true},
		{name: "start-shaped-ack", result: map[string]any{"turn": map[string]any{"id": steerTurnID}}, wantError: true, uncertain: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fixture := &steerFixture{ackMode: tc.ackMode, result: tc.result}
			adapter := NewAppServerAdapter(newSteerFixture(t, fixture))
			adapter.rpcTimeout = steerRPCTimeout
			ctx, cancel := context.WithTimeout(context.Background(), steerFixtureTimeout)
			defer cancel()
			turnID, err := adapter.SteerPrompt(ctx, steerSessionID, steerPrompt, steerTurnID)
			if (err != nil) != tc.wantError {
				t.Fatalf("turn=%q error=%v, wantError=%t", turnID, err, tc.wantError)
			}
			if tc.uncertain && !codex.IsUncertain(err) {
				t.Errorf("unconfirmed steer must report uncertainty: %v", err)
			}
			if err == nil && turnID != steerTurnID || err != nil && turnID != "" {
				t.Errorf("accepted turn ID = %q with error %v", turnID, err)
			}
			if tc.ackMode == "reject" && !strings.Contains(err.Error(), steerRejection) {
				t.Errorf("native rejection reason lost: %v", err)
			}
			if fixture.connections.Load() != 1 || fixture.steers.Load() != 1 || fixture.fallbacks.Load() != 0 {
				t.Errorf("connections=%d steers=%d fallbacks=%d; want exactly one steer with no reconnect/replay/fallback",
					fixture.connections.Load(), fixture.steers.Load(), fixture.fallbacks.Load())
			}
		})
	}
}

func TestSteerPromptInvalidExpectedTurnHasNoTransportOrMutation(t *testing.T) {
	fixture := &steerFixture{}
	adapter := NewAppServerAdapter(newSteerFixture(t, fixture))
	for _, tc := range []struct{ name, turnID string }{
		{"empty", ""},
		{"blank", " "},
		{"leading-space", " " + steerTurnID},
		{"trailing-space", steerTurnID + " "},
		{"embedded-space", "active turn"},
		{"control", "active\x00turn"},
		{"unicode-space", "active\u00a0turn"},
		{"invalid-utf8", string([]byte{0xff})},
		{"replacement-character", "active\ufffdturn"},
		{"oversize", strings.Repeat("t", protocol.MaxTurnIDLength+1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			turnID, err := adapter.SteerPrompt(context.Background(), steerSessionID, steerPrompt, tc.turnID)
			if err == nil || turnID != "" {
				t.Errorf("invalid expectedTurnId returned turn=%q error=%v", turnID, err)
			}
		})
	}
	if fixture.connections.Load() != 0 || fixture.steers.Load() != 0 || fixture.fallbacks.Load() != 0 {
		t.Fatalf("invalid expectedTurnId reached transport: connections=%d steers=%d fallbacks=%d",
			fixture.connections.Load(), fixture.steers.Load(), fixture.fallbacks.Load())
	}
}
