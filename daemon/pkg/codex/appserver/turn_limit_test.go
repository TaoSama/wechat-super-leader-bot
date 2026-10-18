package appserver

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/gorilla/websocket"
)

const (
	turnLimitFixtureTimeout = 10 * time.Second
	turnLimitSessionID      = "limit-session"
	turnLimitTurnID         = "limit-turn"
	turnLimitEscapedBytes   = 2 * 1024 * 1024
	turnLimitOrdinaryBytes  = 8 * 1024 * 1024
	turnLimitNativeBytes    = 64 * 1024 * 1024
)

type turnLimitFixture struct {
	mu          sync.Mutex
	connections map[*websocket.Conn]bool
	methods     []string
	accepted    int
	finished    chan error
	respond     func(*websocket.Conn, steerRequest) error
}

func newTurnLimitFixture(t *testing.T, respond func(*websocket.Conn, steerRequest) error) (*AppServerAdapter, *turnLimitFixture) {
	t.Helper()
	directory, err := os.MkdirTemp("/tmp", "turn-limit-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(directory); err != nil {
			t.Errorf("remove turn limit fixture directory: %v", err)
		}
	})
	socket := filepath.Join(directory, "app.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	fixture := &turnLimitFixture{
		connections: make(map[*websocket.Conn]bool), finished: make(chan error, 1), respond: respond,
	}
	var handlers sync.WaitGroup
	upgrader := websocket.Upgrader{}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handlers.Add(1)
		defer handlers.Done()
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade turn limit fixture connection: %v", err)
			return
		}
		fixture.mu.Lock()
		fixture.connections[conn] = true
		fixture.accepted++
		fixture.mu.Unlock()
		defer func() {
			fixture.mu.Lock()
			delete(fixture.connections, conn)
			fixture.mu.Unlock()
			if err := conn.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
				t.Errorf("close turn limit fixture connection: %v", err)
			}
		}()
		fixture.finished <- fixture.serve(conn)
	}))
	server.Listener = listener
	server.Start()
	t.Cleanup(func() {
		server.Close()
		fixture.mu.Lock()
		for conn := range fixture.connections {
			if err := conn.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
				t.Errorf("stop turn limit fixture connection: %v", err)
			}
		}
		fixture.mu.Unlock()
		joined := make(chan struct{})
		go func() { handlers.Wait(); close(joined) }()
		select {
		case <-joined:
		case <-time.After(turnLimitFixtureTimeout):
			t.Error("turn limit fixture handlers did not stop")
		}
	})
	adapter := NewAppServerAdapter(socket)
	adapter.rpcTimeout = turnLimitFixtureTimeout
	return adapter, fixture
}

func (f *turnLimitFixture) serve(conn *websocket.Conn) error {
	if err := conn.SetReadDeadline(time.Now().Add(turnLimitFixtureTimeout)); err != nil {
		return err
	}
	if err := conn.SetWriteDeadline(time.Now().Add(turnLimitFixtureTimeout)); err != nil {
		return err
	}
	for {
		var request steerRequest
		if err := conn.ReadJSON(&request); err != nil {
			var closeError *websocket.CloseError
			if errors.As(err, &closeError) || errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
				return nil
			}
			return fmt.Errorf("read turn limit fixture request: %w", err)
		}
		f.mu.Lock()
		f.methods = append(f.methods, request.Method)
		f.mu.Unlock()
		switch request.Method {
		case "initialize":
			if err := conn.WriteJSON(map[string]any{"id": request.ID, "result": map[string]any{}}); err != nil {
				return err
			}
		case "initialized":
		case "thread/read":
			want := map[string]any{"threadId": turnLimitSessionID, "includeTurns": true}
			if !reflect.DeepEqual(request.Params, want) {
				return fmt.Errorf("thread/read params = %#v, want %#v", request.Params, want)
			}
			if err := f.respond(conn, request); err != nil {
				return err
			}
		default:
			return fmt.Errorf("unexpected RPC %q; inspection must never mutate or resume", request.Method)
		}
	}
}

func (f *turnLimitFixture) assertReadOnly(t *testing.T) {
	t.Helper()
	select {
	case err := <-f.finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(turnLimitFixtureTimeout):
		t.Fatal("turn limit fixture connection did not close")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	want := []string{"initialize", "initialized", "thread/read"}
	if f.accepted != 1 || !reflect.DeepEqual(f.methods, want) {
		t.Fatalf("connections=%d methods=%v, want one connection and %v without retry/start/resume", f.accepted, f.methods, want)
	}
}

func writeTurnLimitHeader(conn *websocket.Conn, payloadBytes uint64) error {
	// A complete frame header is enough for Gorilla to reject the declared size.
	// Avoid allocating or transmitting a 64 MiB body in the overflow regression.
	header := make([]byte, 10)
	header[0], header[1] = 0x80|websocket.TextMessage, 127
	binary.BigEndian.PutUint64(header[2:], payloadBytes)
	n, err := conn.UnderlyingConn().Write(header)
	if err != nil {
		return err
	}
	if n != len(header) {
		return io.ErrShortWrite
	}
	return nil
}

func TestInspectTurnPreservesMarkdownAboveOrdinaryWebSocketLimit(t *testing.T) {
	output := "\n# 原始 Markdown 🦀\n\n```html\n" + strings.Repeat("<", turnLimitEscapedBytes) + "\n```\n\n- **完成**\n\n"
	if len(output) > protocol.MaxTurnOutputBytes {
		t.Fatalf("fixture raw output exceeds delivery budget: %d", len(output))
	}
	adapter, fixture := newTurnLimitFixture(t, func(conn *websocket.Conn, request steerRequest) error {
		response := map[string]any{"id": request.ID, "result": map[string]any{"thread": map[string]any{
			"id": turnLimitSessionID, "turns": []any{map[string]any{
				"id": turnLimitTurnID, "status": "completed", "items": []any{map[string]any{
					"type": "agentMessage", "phase": "final_answer", "text": output,
				}},
			}},
		}}}
		wire, err := json.Marshal(response)
		if err != nil {
			return err
		}
		if len(wire) <= turnLimitOrdinaryBytes || len(wire) > turnLimitNativeBytes {
			return fmt.Errorf("fixture JSON bytes = %d, want >8 MiB and <=64 MiB", len(wire))
		}
		t.Logf("native response rawBytes=%d wireBytes=%d", len(output), len(wire))
		return conn.WriteMessage(websocket.TextMessage, wire)
	})
	ctx, cancel := context.WithTimeout(context.Background(), turnLimitFixtureTimeout)
	defer cancel()
	observation, err := adapter.InspectTurn(ctx, turnLimitSessionID, turnLimitTurnID)
	if err != nil {
		t.Fatal(err)
	}
	if observation.Status != "completed" || observation.Output != output || observation.Error != "" {
		t.Fatalf("original Markdown changed: status=%q outputBytes=%d wantBytes=%d error=%q", observation.Status, len(observation.Output), len(output), observation.Error)
	}
	fixture.assertReadOnly(t)
}

func TestInspectTurnNativeFrameOverflowReturnsLimitWithoutMutation(t *testing.T) {
	if maxTurnInspectionFrameBytes != turnLimitNativeBytes {
		t.Fatalf("inspection frame limit = %d, want %d", maxTurnInspectionFrameBytes, turnLimitNativeBytes)
	}
	adapter, fixture := newTurnLimitFixture(t, func(conn *websocket.Conn, _ steerRequest) error {
		return writeTurnLimitHeader(conn, turnLimitNativeBytes+1)
	})
	ctx, cancel := context.WithTimeout(context.Background(), turnLimitFixtureTimeout)
	defer cancel()
	observation, err := adapter.InspectTurn(ctx, turnLimitSessionID, turnLimitTurnID)
	if !errors.Is(err, protocol.ErrTurnObservationLimit) {
		t.Fatalf("overflow error = %v, want ErrTurnObservationLimit", err)
	}
	if observation.Status != "" || observation.Output != "" || observation.Error != "" {
		t.Fatalf("overflow returned a partial observation: %+v", observation)
	}
	fixture.assertReadOnly(t)
}

func TestOrdinaryConnectRetainsEightMiBReadLimit(t *testing.T) {
	if MaxWebSocketFrameSize != turnLimitOrdinaryBytes {
		t.Fatalf("ordinary frame limit = %d, want %d", MaxWebSocketFrameSize, turnLimitOrdinaryBytes)
	}
	adapter, fixture := newTurnLimitFixture(t, func(conn *websocket.Conn, _ steerRequest) error {
		return writeTurnLimitHeader(conn, turnLimitOrdinaryBytes+1)
	})
	ctx, cancel := context.WithTimeout(context.Background(), turnLimitFixtureTimeout)
	defer cancel()
	rc, err := adapter.connect(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, err = rc.call(ctx, "thread/read", map[string]any{"threadId": turnLimitSessionID, "includeTurns": true}, turnLimitFixtureTimeout)
	rc.closeLogged()
	if !errors.Is(err, protocol.ErrTurnObservationLimit) {
		t.Fatalf("ordinary connection accepted >8 MiB frame or lost limit error: %v", err)
	}
	fixture.assertReadOnly(t)
}
