package client

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/gorilla/websocket"
)

type diagnosticLogCapture struct {
	records chan controllerSendErrorRecord
}

func (w diagnosticLogCapture) Write(p []byte) (int, error) {
	if strings.Contains(string(p), `"event":"controller_application_send_error"`) {
		var record controllerSendErrorRecord
		if err := json.Unmarshal(p, &record); err != nil {
			return 0, err
		}
		w.records <- record
	}
	return len(p), nil
}

func diagnosticServer(t *testing.T, handle func(*websocket.Conn) error) *httptest.Server {
	t.Helper()
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
		if err := conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
			t.Error(err)
			return
		}
		var hello protocol.DaemonHelloMessage
		if err := conn.ReadJSON(&hello); err != nil {
			t.Error(err)
			return
		}
		if hello.Type != "hello" {
			t.Error("first message was not hello")
			return
		}
		if err := handle(conn); err != nil {
			t.Error(err)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func TestControllerSendDiagnosticPrecedesBlockedRunOnceCleanup(t *testing.T) {
	records := make(chan controllerSendErrorRecord, 4)
	captureDiagnosticLogs(t, diagnosticLogCapture{records: records})
	helloRead := make(chan struct{})
	server := diagnosticServer(t, func(conn *websocket.Conn) error {
		close(helloRead)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return nil // Expected client teardown after the encoding rejection.
			}
		}
	})
	blocked, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	d := NewDaemon(&config.Config{NodeID: "isolated-cleanup", ControllerURL: "ws" + strings.TrimPrefix(server.URL, "http"), HeartbeatInterval: 10 * time.Millisecond},
		&refreshFixture{discover: func(ctx context.Context) ([]protocol.Session, error) {
			once.Do(func() { close(blocked) })
			<-release
			return nil, ctx.Err()
		}})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var releaseOnce sync.Once
	allowCleanup := func() { releaseOnce.Do(func() { close(release) }) }
	defer allowCleanup()
	done := make(chan error, 1)
	go func() { done <- d.runOnce(ctx) }()
	select {
	case <-helloRead:
	case <-ctx.Done():
		t.Fatal("hello missing")
	}
	select {
	case <-blocked:
	case <-ctx.Done():
		t.Fatal("source worker missing")
	}
	d.snapshotMu.Lock()
	d.catalogSnapshot = []protocol.Session{{ID: "synthetic", Title: strings.Repeat("x", protocol.MaxControllerMessageBytes)}}
	d.snapshotMu.Unlock()
	select {
	case record := <-records:
		if record.Stage != controllerEncode || record.MessageKind != "heartbeat" || record.ErrorClass != "payload_limit" || record.ConnectionPhase != controllerActive {
			t.Fatalf("unexpected first error: %+v", record)
		}
	case <-ctx.Done():
		t.Fatal("diagnostic waited for cleanup")
	}
	select {
	case err := <-done:
		t.Fatalf("cleanup gate was not exercised: %v", err)
	default:
	}
	allowCleanup()
	select {
	case err := <-done:
		if !errors.Is(err, errControllerPayloadLimit) {
			t.Fatalf("original heartbeat error not propagated: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("cleanup did not finish after gate release")
	}
	if len(records) != 0 {
		t.Fatal("cleanup repeated the first diagnostic")
	}
}

type diagnosticLateReadAdapter struct {
	receiptAdapter
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (a *diagnosticLateReadAdapter) ReadSession(ctx context.Context, _ string) (string, error) {
	a.once.Do(func() { close(a.started) })
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case <-a.release:
		return "isolated result", nil
	}
}

func TestControllerSendLateWorkerFirstErrorAfterRunOnceCleanup(t *testing.T) {
	records := make(chan controllerSendErrorRecord, 4)
	captureDiagnosticLogs(t, diagnosticLogCapture{records: records})
	adapter := &diagnosticLateReadAdapter{started: make(chan struct{}), release: make(chan struct{})}
	server := diagnosticServer(t, func(conn *websocket.Conn) error {
		cmd := persistenceCommand(time.Now().Add(time.Minute).Format(time.RFC3339Nano))
		cmd.NodeID, cmd.Action, cmd.Prompt = "isolated-late", protocol.ActionRead, ""
		if err := conn.WriteJSON(cmd); err != nil {
			return err
		}
		select {
		case <-adapter.started:
			return nil // The command continues under the daemon root context.
		case <-time.After(time.Second):
			return errors.New("root worker did not start")
		}
	})
	d := NewDaemon(&config.Config{NodeID: "isolated-late", ControllerURL: "ws" + strings.TrimPrefix(server.URL, "http")}, adapter)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := d.runOnce(ctx); err == nil {
		t.Fatal("connection close was not propagated")
	}
	if len(records) != 0 {
		t.Fatal("read-only disconnection invented an application write error")
	}
	close(adapter.release)
	select {
	case record := <-records:
		if record.ConnectionPhase != controllerAfterCleanup || record.MessageKind != "result" || record.ErrorClass != "closed" {
			t.Fatalf("late result lost original attempt lifecycle: %+v", record)
		}
	case <-ctx.Done():
		t.Fatal("late worker first error was not emitted")
	}
	d.workers.Wait()
	if len(records) != 0 {
		t.Fatal("late result emitted more than once")
	}
}
