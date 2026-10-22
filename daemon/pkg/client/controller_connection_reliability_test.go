package client

import (
	"context"
	"errors"
	"fmt"
	"net"
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

type controllerPipeListener struct {
	conn      net.Conn
	accepted  sync.Once
	closed    chan struct{}
	closeOnce sync.Once
}

func (l *controllerPipeListener) Accept() (net.Conn, error) {
	var conn net.Conn
	l.accepted.Do(func() { conn = l.conn })
	if conn != nil {
		return conn, nil
	}
	<-l.closed
	return nil, net.ErrClosed
}
func (l *controllerPipeListener) Close() error {
	l.closeOnce.Do(func() { close(l.closed) })
	return nil
}
func (l *controllerPipeListener) Addr() net.Addr { return l.conn.LocalAddr() }

type controllerSlowReadConn struct{ net.Conn }

func (c controllerSlowReadConn) Read(p []byte) (int, error) {
	const readDelay = 5 * time.Millisecond
	time.Sleep(readDelay)
	return c.Conn.Read(p[:min(len(p), controllerWriteChunkBytes)])
}

// An unbuffered pipe makes each write depend on actual receiver progress rather
// than allowing the operating system's TCP buffers to hide a fixed deadline.
func controllerPipePair(t *testing.T) (*websocket.Conn, *websocket.Conn) {
	t.Helper()
	client, peer := net.Pipe()
	listener := &controllerPipeListener{conn: controllerSlowReadConn{peer}, closed: make(chan struct{})}
	peers := make(chan *websocket.Conn, 1)
	errorsCh := make(chan error, 1)
	release := make(chan struct{})
	upgrader := websocket.Upgrader{}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			errorsCh <- err
			return
		}
		peers <- conn
		<-release
	})}
	served := make(chan error, 1)
	go func() { served <- server.Serve(listener) }()
	dialer := websocket.Dialer{HandshakeTimeout: time.Second, NetDialContext: func(context.Context, string, string) (net.Conn, error) {
		return client, nil
	}}
	conn, _, err := dialer.Dial("ws://fixture", nil)
	if err != nil {
		close(release)
		if closeErr := client.Close(); closeErr != nil {
			t.Log(closeErr)
		}
		if closeErr := peer.Close(); closeErr != nil {
			t.Log(closeErr)
		}
		if closeErr := server.Close(); closeErr != nil {
			t.Log(closeErr)
		}
		t.Fatal(err)
	}
	var remote *websocket.Conn
	select {
	case remote = <-peers:
	case err := <-errorsCh:
		t.Fatal(err)
	case <-time.After(time.Second):
		t.Fatal("pipe upgrade did not complete")
	}
	t.Cleanup(func() {
		for _, connection := range []*websocket.Conn{conn, remote} {
			if err := connection.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
				t.Error(err)
			}
		}
		close(release)
		if err := server.Close(); err != nil {
			t.Error(err)
		}
		if err := <-served; err != nil && !errors.Is(err, http.ErrServerClosed) && !errors.Is(err, net.ErrClosed) {
			t.Error(err)
		}
	})
	return conn, remote
}

func TestControllerSlowProgressingResultCompletesWithControlKeepalives(t *testing.T) {
	conn, remote := controllerPipePair(t)
	result := protocol.DaemonResultMessage{Type: "result", CommandID: "slow-result", Status: protocol.StatusCompleted,
		Output: strings.Repeat("<", 128*1024)}
	encoded, err := encodeControllerMessage(result)
	if err != nil {
		t.Fatal(err)
	}
	var pings atomic.Int32
	remote.SetPingHandler(func(string) error { pings.Add(1); return nil })
	received := make(chan error, 1)
	go func() {
		var got protocol.DaemonResultMessage
		err := remote.ReadJSON(&got)
		if err == nil && !protocol.SameResult(got, result) {
			err = errors.New("slow transmission changed the complete result")
		}
		received <- err
	}()
	const idleTimeout = 250 * time.Millisecond
	started := time.Now()
	if err := writeControllerMessage(conn, encoded, idleTimeout, 100*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if err := <-received; err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(started); elapsed <= idleTimeout || pings.Load() == 0 {
		t.Fatalf("fixture did not cross the whole-message deadline with keepalives: elapsed=%s pings=%d", elapsed, pings.Load())
	}
	t.Logf("complete raw=%d wire=%d elapsed=%s idle=%s pings=%d", len(result.Output), len(encoded), time.Since(started), idleTimeout, pings.Load())
}

func TestControllerStalledResultHasBoundedWriteTimeout(t *testing.T) {
	conn, _ := controllerPipePair(t)
	const idleTimeout = 100 * time.Millisecond
	started := time.Now()
	err := writeControllerMessage(conn, []byte(strings.Repeat("x", 32*1024)), idleTimeout, time.Second)
	var timeout net.Error
	if !errors.As(err, &timeout) || !timeout.Timeout() {
		t.Fatalf("stalled receiver did not cause a network timeout: %v", err)
	}
	if elapsed := time.Since(started); elapsed < idleTimeout || elapsed > time.Second {
		t.Fatalf("stall deadline was not bounded: %s", elapsed)
	}
}

type controllerReplayAdapter struct {
	receiptAdapter
	readStarted chan struct{}
	reads       atomic.Int32
}

func (a *controllerReplayAdapter) ReadSession(context.Context, string) (string, error) {
	if a.reads.Add(1) == 1 {
		close(a.readStarted)
	}
	return "new command result", nil
}

const controllerFixtureIdleTimeout = 5 * time.Second

type controllerProgressReadConn struct {
	net.Conn
	enabled atomic.Bool
}

func (c *controllerProgressReadConn) Read(p []byte) (int, error) {
	if c.enabled.Load() {
		if err := c.Conn.SetReadDeadline(time.Now().Add(controllerFixtureIdleTimeout)); err != nil {
			return 0, err
		}
	}
	return c.Conn.Read(p)
}

type controllerProgressListener struct{ net.Listener }

func (l controllerProgressListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &controllerProgressReadConn{Conn: conn}, nil
}

type controllerAckJournal struct {
	commandJournal
	commandID string
	acked     chan struct{}
	once      sync.Once
}

func (j *controllerAckJournal) Ack(ack protocol.ResultAckMessage) error {
	if err := j.commandJournal.Ack(ack); err != nil {
		return err
	}
	if ack.CommandID == j.commandID {
		j.once.Do(func() { close(j.acked) })
	}
	return nil
}

func TestControllerDurableReplayKeepsReaderLiveAndRecoversAfterReconnect(t *testing.T) {
	adapter := &controllerReplayAdapter{readStarted: make(chan struct{})}
	result := protocol.DaemonResultMessage{Type: "result", CommandID: "saved-result", Status: protocol.StatusCompleted,
		Output: strings.Repeat("<", 2*1024*1024)}
	var attempts atomic.Int32
	serverResults := make(chan error, 2)
	acked := make(chan struct{})
	upgrader := websocket.Upgrader{}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			serverResults <- err
			return
		}
		// HTTP hijacking uses deadlines to interrupt its background reader.
		// Only take over deadline renewal after that handoff has completed.
		conn.UnderlyingConn().(*controllerProgressReadConn).enabled.Store(true)
		defer func() {
			if err := conn.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
				t.Log(err)
			}
		}()
		var hello protocol.DaemonHelloMessage
		if err := conn.ReadJSON(&hello); err != nil {
			serverResults <- err
			return
		}
		if attempts.Add(1) == 1 {
			cmd := persistenceCommand(time.Now().Add(time.Minute).Format(time.RFC3339Nano))
			cmd.CommandID, cmd.Action, cmd.Prompt = "new-command", protocol.ActionRead, ""
			if err := conn.WriteJSON(cmd); err != nil {
				serverResults <- err
				return
			}
			// Do not consume the large replay until its independent reader has
			// dispatched the command. A synchronous initial flush deadlocks here.
			select {
			case <-adapter.readStarted:
				serverResults <- nil
			case <-time.After(time.Second):
				serverResults <- errors.New("initial durable replay blocked the command reader")
			}
			return
		}
		for {
			var got protocol.DaemonResultMessage
			if err := conn.ReadJSON(&got); err != nil {
				serverResults <- fmt.Errorf("read replay: %w", err)
				return
			}
			if got.Type != "result" {
				continue
			}
			if err := conn.WriteJSON(protocol.ResultAckMessage{Type: "result_ack", CommandID: got.CommandID, Status: got.Status, TurnID: got.TurnID}); err != nil {
				serverResults <- err
				return
			}
			if got.CommandID == result.CommandID {
				if !protocol.SameResult(got, result) {
					serverResults <- errors.New("reconnect lost the exact original result")
					return
				}
				// Do not race socket teardown against the reader's durable ACK.
				select {
				case <-acked:
					serverResults <- nil
				case <-time.After(controllerFixtureIdleTimeout):
					serverResults <- errors.New("replayed result ACK was not persisted")
				}
				return
			}
		}
	}))
	// Keep the same five-second stall bound while allowing ongoing network
	// progress and JSON/journal work to outlast a whole-session test deadline.
	server.Listener = controllerProgressListener{server.Listener}
	server.Start()
	defer server.Close()
	cfg := persistenceConfig(t.TempDir())
	cfg.ControllerURL = "ws" + strings.TrimPrefix(server.URL, "http")
	d, err := OpenDaemon(cfg, adapter)
	if err != nil {
		t.Fatal(err)
	}
	d.journal = &controllerAckJournal{commandJournal: d.journal, commandID: result.CommandID, acked: acked}
	defer closeDaemon(t, d)
	defer d.workers.Wait()
	cmd := persistenceCommand(time.Now().Add(time.Minute).Format(time.RFC3339Nano))
	cmd.CommandID = result.CommandID
	if _, created, err := d.journal.Begin(cmd); err != nil || !created {
		t.Fatalf("begin saved result: created=%t error=%v", created, err)
	}
	if err := d.journal.Finish(result); err != nil {
		t.Fatal(err)
	}
	for attempt := 1; attempt <= 2; attempt++ {
		ctx, cancel := context.WithCancel(context.Background())
		runErr := d.runOnce(ctx)
		cancel()
		if runErr == nil {
			t.Fatal("fixture disconnect was not reported")
		}
		if err := <-serverResults; err != nil {
			t.Fatalf("attempt %d: fixture=%v daemon=%v", attempt, err, runErr)
		}
		pending, err := d.journal.Unacked()
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, got := range pending {
			if got.CommandID == result.CommandID {
				found = true
				if !protocol.SameResult(got, result) {
					t.Fatal("unacknowledged result was truncated or replaced")
				}
			}
		}
		if found != (attempt == 1) {
			t.Fatalf("attempt %d: saved result pending=%t", attempt, found)
		}
	}
	d.workers.Wait()
	if adapter.reads.Load() != 1 {
		t.Fatalf("reconnect repeated command dispatch: %d", adapter.reads.Load())
	}
}

func TestControllerConcurrentResultsRemainWholeMessages(t *testing.T) {
	const commandCount = 24
	serverResult := make(chan error, 1)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			serverResult <- err
			return
		}
		defer func() {
			if err := conn.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
				t.Log(err)
			}
		}()
		var hello protocol.DaemonHelloMessage
		if err := conn.ReadJSON(&hello); err != nil {
			serverResult <- err
			return
		}
		for i := range commandCount {
			cmd := persistenceCommand(time.Now().Add(time.Minute).Format(time.RFC3339Nano))
			cmd.CommandID, cmd.SessionID = fmt.Sprintf("concurrent-%d", i), fmt.Sprintf("session-%d", i)
			cmd.Action, cmd.Prompt = protocol.ActionRead, ""
			if err := conn.WriteJSON(cmd); err != nil {
				serverResult <- err
				return
			}
		}
		seen := make(map[string]bool)
		for len(seen) < commandCount {
			var got protocol.DaemonResultMessage
			if err := conn.ReadJSON(&got); err != nil {
				serverResult <- err
				return
			}
			if got.Type == "result" {
				if got.Status != protocol.StatusCompleted || got.Output != "fixture read" {
					serverResult <- fmt.Errorf("corrupt concurrent result: %+v", got)
					return
				}
				seen[got.CommandID] = true
			}
		}
		serverResult <- nil
	}))
	defer server.Close()
	d := NewDaemon(&config.Config{NodeID: "demoair", ControllerURL: "ws" + strings.TrimPrefix(server.URL, "http"),
		HeartbeatInterval: time.Millisecond}, &receiptAdapter{})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := d.runOnce(ctx); err == nil {
		t.Fatal("fixture disconnect was not reported")
	}
	d.workers.Wait()
	if err := <-serverResult; err != nil {
		t.Fatal(err)
	}
}
