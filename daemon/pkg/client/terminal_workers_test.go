package client

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/gorilla/websocket"
)

func awaitTerminalSignal(t *testing.T, signal <-chan struct{}, description string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(4 * time.Second):
		t.Fatal(description)
	}
}

func terminalControllerFixture(t *testing.T) (*httptest.Server, <-chan json.RawMessage, <-chan *websocket.Conn) {
	t.Helper()
	frames, connections := make(chan json.RawMessage, 64), make(chan *websocket.Conn, 1)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("fixture upgrade: %v", err)
			return
		}
		defer func() {
			if err := conn.Close(); err != nil {
				t.Logf("fixture close: %v", err)
			}
		}()
		if err := conn.SetReadDeadline(time.Now().Add(10 * time.Second)); err != nil {
			t.Errorf("fixture read deadline: %v", err)
			return
		}
		connections <- conn
		for {
			var frame json.RawMessage
			if err := conn.ReadJSON(&frame); err != nil {
				return
			}
			select {
			case frames <- frame:
			case <-r.Context().Done():
				return
			}
		}
	}))
	return server, frames, connections
}

func nextTerminalFrame(t *testing.T, frames <-chan json.RawMessage, message any) {
	t.Helper()
	select {
	case frame := <-frames:
		if err := json.Unmarshal(frame, message); err != nil {
			t.Fatalf("bad controller frame: %s: %v", frame, err)
		}
	case <-time.After(time.Second):
		t.Fatal("source discovery blocked controller delivery")
	}
}

func TestTerminalSlowInitialDiscoveryKeepsHelloReplayHeartbeatsAndOtherSources(t *testing.T) {
	server, frames, connections := terminalControllerFixture(t)
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	terminalStarted, releaseTerminal, desktopObserved, nativeRefreshed := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	var active atomic.Int32
	var desktopOnce, nativeOnce sync.Once
	d := NewDaemon(&config.Config{NodeID: "node", ControllerURL: "ws" + strings.TrimPrefix(server.URL, "http"), HeartbeatInterval: 20 * time.Millisecond},
		&refreshFixture{discover: func(context.Context) ([]protocol.Session, error) {
			nativeOnce.Do(func() { close(nativeRefreshed) })
			return []protocol.Session{{ID: "native", Status: "idle", ObservedAt: "native-time"}}, nil
		}})
	d.sessionSnapshot = []protocol.Session{{ID: "native", Status: "unknown", ObservedAt: "cached-time"}}
	terminalSession := terminalFixtureSession("one")
	d.terminalObserver = &catalogFixture{discover: func(ctx context.Context) ([]protocol.Session, error) {
		active.Add(1)
		defer active.Add(-1)
		close(terminalStarted)
		select {
		case <-releaseTerminal:
			return []protocol.Session{terminalSession}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}}
	d.desktopObserver = &desktopFixture{watch: func(ctx context.Context, ids []string, publish func(string, protocol.DesktopObservation)) error {
		if len(ids) != 1 || ids[0] != "native" {
			return errors.New("unexpected desktop identities")
		}
		active.Add(1)
		defer active.Add(-1)
		publish("native", protocol.DesktopObservation{Status: "idle", Availability: "available", ObservedAt: "desktop-time"})
		desktopOnce.Do(func() { close(desktopObserved) })
		<-ctx.Done()
		return ctx.Err()
	}}
	replay := protocol.DaemonResultMessage{Type: "result", CommandID: "cached-read", Status: protocol.StatusCompleted, Output: "cached receipt"}
	d.queueResult(replay)
	done := make(chan error, 1)
	go func() { done <- d.runOnce(ctx) }()
	joined := false
	defer func() {
		cancel()
		if !joined {
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Error("run not joined")
			}
		}
	}()
	var hello protocol.DaemonHelloMessage
	nextTerminalFrame(t, frames, &hello)
	if hello.Type != "hello" || len(hello.Sessions) != 1 || hello.Sessions[0].ObservedAt != "cached-time" {
		t.Fatalf("hello waited for source: %+v", hello)
	}
	var receipt protocol.DaemonResultMessage
	nextTerminalFrame(t, frames, &receipt)
	if receipt != replay {
		t.Fatalf("initial terminal blocked receipt replay: %+v", receipt)
	}
	awaitTerminalSignal(t, terminalStarted, "terminal not started after hello")
	awaitTerminalSignal(t, nativeRefreshed, "terminal blocked native refresh")
	awaitTerminalSignal(t, desktopObserved, "terminal blocked desktop refresh")
	for heartbeats := 0; heartbeats < 3; {
		var heartbeat protocol.DaemonHeartbeatMessage
		nextTerminalFrame(t, frames, &heartbeat)
		if heartbeat.Type == "result" {
			continue
		}
		if heartbeat.Type != "heartbeat" || len(heartbeat.Sessions) != 1 {
			t.Fatalf("blocked terminal changed liveness: %+v", heartbeat)
		}
		heartbeats++
	}
	close(releaseTerminal)
	deadline := time.After(time.Second)
	visible := false
	for !visible {
		select {
		case frame := <-frames:
			var heartbeat protocol.DaemonHeartbeatMessage
			if err := json.Unmarshal(frame, &heartbeat); err != nil {
				t.Fatal(err)
			}
			for _, session := range heartbeat.Sessions {
				if session.ID == terminalSession.ID {
					visible = true
					if session.Status != "active" || session.ObservedAt != "original-time" {
						t.Fatalf("bad terminal update: %+v", session)
					}
				}
			}
		case <-deadline:
			t.Fatal("first terminal result not published through updates")
		}
	}
	conn := <-connections
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		joined = true
		if err == nil {
			t.Fatal("disconnect not reported")
		}
	case <-time.After(time.Second):
		t.Fatal("disconnect did not join source workers")
	}
	if active.Load() != 0 {
		t.Fatalf("source workers survived disconnect: %d", active.Load())
	}
	if got := d.cachedSessions(); len(got) != 2 || got[1].Status != "unknown" || got[1].ObservedAt != "original-time" {
		t.Fatalf("disconnect invalidation refreshed old time: %+v", got)
	}
}

func TestTerminalInitialFailureDoesNotPreventConnection(t *testing.T) {
	server, frames, _ := terminalControllerFixture(t)
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	d := NewDaemon(&config.Config{ControllerURL: "ws" + strings.TrimPrefix(server.URL, "http"), HeartbeatInterval: 20 * time.Millisecond}, &terminalRouteAdapter{})
	terminalSession := terminalFixtureSession("one")
	var err error
	d.terminalSnapshot, err = normalizeTerminalSessions([]protocol.Session{terminalSession})
	if err != nil {
		t.Fatal(err)
	}
	d.terminalObserver = &catalogFixture{discover: func(context.Context) ([]protocol.Session, error) { return nil, errors.New("PRIVATE_ENDPOINT") }}
	done := make(chan error, 1)
	go func() { done <- d.runOnce(ctx) }()
	joined := false
	defer func() {
		cancel()
		if !joined {
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Error("run not joined")
			}
		}
	}()
	var hello protocol.DaemonHelloMessage
	nextTerminalFrame(t, frames, &hello)
	if hello.Type != "hello" || len(hello.Sessions) != 1 || hello.Sessions[0].Status != "active" {
		t.Fatalf("initial hello changed cache before source result: %+v", hello)
	}
	revoked := false
	deadline := time.After(time.Second)
	for !revoked {
		select {
		case frame := <-frames:
			var heartbeat protocol.DaemonHeartbeatMessage
			if err := json.Unmarshal(frame, &heartbeat); err != nil {
				t.Fatal(err)
			}
			if len(heartbeat.Sessions) == 1 && heartbeat.Sessions[0].Status == "unknown" {
				revoked = true
				if heartbeat.Sessions[0].ObservedAt != "original-time" {
					t.Fatal("source failure refreshed observation time")
				}
			}
		case <-deadline:
			t.Fatal("failed initial discovery did not revoke terminal source")
		}
	}
	cancel()
	select {
	case <-done:
		joined = true
	case <-time.After(time.Second):
		t.Fatal("canceled connection did not join workers")
	}
}

func TestTerminalSlowDiscoveryCancellationJoinsAndDialFailureStartsNoWorkers(t *testing.T) {
	t.Run("cancel-connected", func(t *testing.T) {
		server, frames, _ := terminalControllerFixture(t)
		defer server.Close()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		started := make(chan struct{})
		var active atomic.Int32
		d := NewDaemon(&config.Config{ControllerURL: "ws" + strings.TrimPrefix(server.URL, "http")}, &terminalRouteAdapter{})
		d.terminalObserver = &catalogFixture{discover: func(ctx context.Context) ([]protocol.Session, error) {
			active.Add(1)
			defer active.Add(-1)
			close(started)
			<-ctx.Done()
			return nil, ctx.Err()
		}}
		done := make(chan error, 1)
		go func() { done <- d.runOnce(ctx) }()
		var hello protocol.DaemonHelloMessage
		nextTerminalFrame(t, frames, &hello)
		awaitTerminalSignal(t, started, "terminal worker not started")
		cancel()
		select {
		case err := <-done:
			if !errors.Is(err, context.Canceled) || active.Load() != 0 {
				t.Fatalf("canceled discovery not joined: %v active=%d", err, active.Load())
			}
		case <-time.After(time.Second):
			t.Fatal("canceled run leaked discovery")
		}
	})
	t.Run("dial-failure", func(t *testing.T) {
		var calls atomic.Int32
		d := NewDaemon(&config.Config{ControllerURL: "invalid-url"}, &refreshFixture{discover: func(context.Context) ([]protocol.Session, error) { calls.Add(1); return nil, nil }})
		d.terminalObserver = &catalogFixture{discover: func(context.Context) ([]protocol.Session, error) { calls.Add(1); return nil, nil }}
		d.terminalSnapshot = []protocol.Session{terminalFixtureSession("cached")}
		if err := d.runOnce(context.Background()); err == nil {
			t.Fatal("invalid URL connected")
		}
		if calls.Load() != 0 {
			t.Fatal("dial failure started source workers")
		}
		if d.cachedSessions()[0].Status != "active" {
			t.Fatal("dial failure modified cached source without starting workers")
		}
	})
}
