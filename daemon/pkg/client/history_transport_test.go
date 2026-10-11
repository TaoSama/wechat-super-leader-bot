package client

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/gorilla/websocket"
)

type historyFixture struct {
	history  protocol.SessionHistory
	err      error
	started  chan struct{}
	canceled atomic.Int32
	called   atomic.Int32
	limit    int
}

func (a *historyFixture) DiscoverSessions(context.Context) ([]protocol.Session, error) {
	return []protocol.Session{}, nil
}
func (a *historyFixture) ReadSession(context.Context, string) (string, error) {
	return "command output", nil
}
func (a *historyFixture) SendPrompt(context.Context, string, string) (string, error) {
	return "", errors.New("fixture does not send")
}
func (a *historyFixture) ReadHistory(ctx context.Context, id, cursor string, limit int) (protocol.SessionHistory, error) {
	a.called.Add(1)
	if a.started != nil {
		a.started <- struct{}{}
		<-ctx.Done()
		a.canceled.Add(1)
		return protocol.SessionHistory{}, ctx.Err()
	}
	a.limit = limit
	return a.history, a.err
}

func TestReadHistoryStaticErrorsAndNoCommandReceipt(t *testing.T) {
	msg := protocol.ReadHistoryMessage{Type: "read_history", NodeID: "node", RequestID: "request", SessionID: "session"}
	for _, tc := range []struct {
		name    string
		err     error
		session string
		node    string
		want    string
	}{
		{"valid", nil, "session", "node", ""},
		{"wrong-node", nil, "session", "other", protocol.HistoryInvalidRequest},
		{"wrong-thread", nil, "other", "node", protocol.HistoryFailed},
		{"upstream-secret", errors.New("token=PRIVATE_SECRET socket=/private/path"), "session", "node", protocol.HistoryFailed},
		{"unsupported", errors.New(protocol.HistoryUnavailable), "session", "node", protocol.HistoryUnavailable},
		{"deadline", context.DeadlineExceeded, "session", "node", protocol.HistoryTimeout},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := &historyFixture{history: protocol.SessionHistory{Session: protocol.Session{ID: tc.session}, Items: []protocol.HistoryItem{}}, err: tc.err}
			d := NewDaemon(&config.Config{NodeID: "node"}, a)
			request := msg
			request.NodeID = tc.node
			res := d.ReadHistory(context.Background(), request)
			if res.Error != tc.want || res.Type != "history" || res.RequestID != "request" || res.SessionID != "session" || (res.History != nil) != (tc.want == "") {
				t.Fatalf("incorrect history response: %+v", res)
			}
			if tc.want == "" && a.limit != protocol.DefaultHistoryLimit {
				t.Fatal("default history limit not applied")
			}
			if len(d.outbox) != 0 || len(d.dedupeCache) != 0 || len(d.inFlight) != 0 || len(d.sessionLocks) != 0 {
				t.Fatal("history must not enter command bookkeeping")
			}
			if tc.node != "node" && a.called.Load() != 0 {
				t.Fatal("wrong node reached adapter")
			}
		})
	}
}

func TestReadHistoryLegacyAdapterAndOversizeIdentity(t *testing.T) {
	a := &transportAdapter{inspectingAdapter: inspectingAdapter{status: "completed"}}
	d := NewDaemon(&config.Config{NodeID: "node"}, a)
	msg := protocol.ReadHistoryMessage{Type: "read_history", NodeID: "node", RequestID: "request", SessionID: "session"}
	if res := d.ReadHistory(context.Background(), msg); res.Error != protocol.HistoryUnavailable {
		t.Fatalf("legacy adapter contract broken: %+v", res)
	}
	msg.RequestID = strings.Repeat("x", protocol.MaxHistoryResponseBytes+1)
	res := d.ReadHistory(context.Background(), msg)
	encoded, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	if res.Error != protocol.HistoryInvalidRequest || len(encoded) >= protocol.MaxHistoryResponseBytes {
		t.Fatal("invalid request can inflate response")
	}
}

func TestBlockedHistoryKeepsHeartbeatCommandsAndCancelsOnDisconnect(t *testing.T) {
	a := &historyFixture{started: make(chan struct{}, maxConcurrentHistoryReads)}
	done := make(chan error, 1)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			done <- err
			return
		}
		defer func() {
			if err := conn.Close(); err != nil {
				t.Logf("fixture close: %v", err)
			}
		}()
		if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
			done <- err
			return
		}
		var hello protocol.DaemonHelloMessage
		if err := conn.ReadJSON(&hello); err != nil {
			done <- err
			return
		}
		for i := 0; i <= maxConcurrentHistoryReads; i++ {
			msg := protocol.ReadHistoryMessage{Type: "read_history", RequestID: fmt.Sprintf("request-%d", i), NodeID: "node", SessionID: "session"}
			if err := conn.WriteJSON(msg); err != nil {
				done <- err
				return
			}
			if i < maxConcurrentHistoryReads {
				select {
				case <-a.started:
				case <-time.After(time.Second):
					done <- errors.New("history worker did not start")
					return
				}
			}
		}
		cmd := protocol.ControllerCommandMessage{Type: "command", NodeID: "node", SessionID: "session", CommandID: "command", Action: protocol.ActionRead, ExpiresAt: time.Now().Add(time.Minute).Format(time.RFC3339Nano)}
		if err := conn.WriteJSON(cmd); err != nil {
			done <- err
			return
		}
		busy, heartbeat, command := false, false, false
		for !busy || !heartbeat || !command {
			var response map[string]any
			if err := conn.ReadJSON(&response); err != nil {
				done <- err
				return
			}
			switch response["type"] {
			case "history":
				if response["requestId"] != "request-4" || response["error"] != protocol.HistoryBusy {
					done <- errors.New("unexpected history capacity response")
					return
				}
				busy = true
			case "heartbeat":
				heartbeat = true
			case "result":
				if response["commandId"] != "command" || response["status"] != "completed" {
					done <- errors.New("command blocked or failed")
					return
				}
				command = true
			}
		}
		done <- nil
	}))
	defer server.Close()
	d := NewDaemon(&config.Config{NodeID: "node", NodeToken: "fixture", ControllerURL: "ws" + strings.TrimPrefix(server.URL, "http"), HeartbeatInterval: 10 * time.Millisecond}, a)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	exited := make(chan error, 1)
	go func() { exited <- d.runOnce(ctx) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("transport stalled")
	}
	select {
	case <-exited:
	case <-time.After(time.Second):
		t.Fatal("disconnect did not cancel history workers")
	}
	if a.called.Load() != maxConcurrentHistoryReads || a.canceled.Load() != maxConcurrentHistoryReads {
		t.Fatalf("history workers not bounded/cleaned: called=%d canceled=%d", a.called.Load(), a.canceled.Load())
	}
}
