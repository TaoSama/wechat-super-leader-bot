package appserver

import (
	"context"
	"encoding/json"
	"reflect"
	"sync/atomic"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/gorilla/websocket"
)

// interruptFixture reuses the steer socket lifecycle while serving turn/interrupt.
type interruptFixture struct {
	steerFixture
	interrupts atomic.Int32
	loaded     bool
}

func (f *interruptFixture) serveInterrupt(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	for {
		var request steerRequest
		if err := conn.ReadJSON(&request); err != nil {
			return
		}
		result := map[string]any{}
		switch request.Method {
		case "initialize":
		case "initialized":
			continue
		case "thread/loaded/list":
			data := []string{}
			if f.loaded {
				data = []string{steerSessionID}
			}
			result = map[string]any{"data": data, "nextCursor": nil}
		case "turn/interrupt":
			f.interrupts.Add(1)
			want := map[string]any{"threadId": steerSessionID, "turnId": steerTurnID}
			if !reflect.DeepEqual(request.Params, want) {
				t.Errorf("turn/interrupt parameters = %#v, want %#v", request.Params, want)
				return
			}
			switch f.ackMode {
			case "disconnect":
				return
			case "timeout":
				continue
			case "reject":
				if err := conn.WriteJSON(map[string]any{"jsonrpc": "2.0", "id": request.ID,
					"error": map[string]any{"code": -32600, "message": "no active turn"}}); err != nil {
					t.Errorf("write native rejection: %v", err)
				}
				continue
			case "invalid":
				id, err := json.Marshal(request.ID)
				if err != nil {
					t.Errorf("encode request id: %v", err)
					return
				}
				if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"jsonrpc":"2.0","id":`+string(id)+`,"result":{"x":"`+"\xff"+`"}}`)); err != nil {
					t.Errorf("write invalid response: %v", err)
				}
				continue
			}
		default:
			f.fallbacks.Add(1)
			t.Errorf("interrupt attempted unexpected RPC %q", request.Method)
			return
		}
		if err := conn.WriteJSON(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result}); err != nil {
			t.Errorf("write fixture response: %v", err)
			return
		}
	}
}

func newInterruptFixture(t *testing.T, fixture *interruptFixture) string {
	t.Helper()
	return newRPCSocketFixture(t, &fixture.connections, fixture.serveInterrupt)
}

func TestInterruptTurnNativeProtocolAndClassification(t *testing.T) {
	for _, tc := range []struct {
		name       string
		ackMode    string
		loaded     bool
		wantError  bool
		uncertain  bool
		interrupts int32
	}{
		{name: "acknowledged", loaded: true, interrupts: 1},
		{name: "not-loaded", wantError: true, interrupts: 0},
		{name: "native-rejection", ackMode: "reject", loaded: true, wantError: true, interrupts: 1},
		{name: "lost-ack-connection", ackMode: "disconnect", loaded: true, wantError: true, uncertain: true, interrupts: 1},
		{name: "lost-ack-timeout", ackMode: "timeout", loaded: true, wantError: true, uncertain: true, interrupts: 1},
		{name: "invalid-response", ackMode: "invalid", loaded: true, wantError: true, uncertain: true, interrupts: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fixture := &interruptFixture{steerFixture: steerFixture{ackMode: tc.ackMode}, loaded: tc.loaded}
			adapter := NewAppServerAdapter(newInterruptFixture(t, fixture))
			adapter.rpcTimeout = steerRPCTimeout
			ctx, cancel := context.WithTimeout(context.Background(), steerFixtureTimeout)
			defer cancel()
			err := adapter.InterruptTurn(ctx, steerSessionID, steerTurnID)
			if (err != nil) != tc.wantError || codex.IsUncertain(err) != tc.uncertain {
				t.Fatalf("error=%v wantError=%t uncertain=%t", err, tc.wantError, tc.uncertain)
			}
			if fixture.interrupts.Load() != tc.interrupts || fixture.fallbacks.Load() != 0 {
				t.Fatalf("interrupts=%d fallbacks=%d", fixture.interrupts.Load(), fixture.fallbacks.Load())
			}
		})
	}
}

func TestInterruptTurnRejectsInvalidIdentityWithoutConnecting(t *testing.T) {
	adapter := NewAppServerAdapter("/tmp/interrupt-never-dialed.sock")
	for _, tc := range [][2]string{{"terminal:pane", steerTurnID}, {steerSessionID, ""}, {steerSessionID, "bad turn"}} {
		if err := adapter.InterruptTurn(context.Background(), tc[0], tc[1]); err == nil || codex.IsUncertain(err) {
			t.Fatalf("target %v error = %v", tc, err)
		}
	}
}
