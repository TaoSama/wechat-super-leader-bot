package client

import (
	"context"
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

type transportAdapter struct {
	inspectingAdapter
	sends atomic.Int32
}

func (a *transportAdapter) SendPrompt(context.Context, string, string) (string, error) {
	a.sends.Add(1)
	return "turnId=target", nil
}

func TestReconnectReplaysAcceptanceAndOnlyInspectsTurn(t *testing.T) {
	var connections atomic.Int32
	done := make(chan error, 2)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			done <- err
			return
		}
		defer func() {
			if err := conn.Close(); err != nil {
				t.Logf("test connection cleanup: %v", err)
			}
		}()
		if err := conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
			done <- err
			return
		}
		var hello protocol.DaemonHelloMessage
		if err := conn.ReadJSON(&hello); err != nil {
			done <- err
			return
		}
		if hello.Type != "hello" {
			done <- fmt.Errorf("expected hello, got %s", hello.Type)
			return
		}
		first := connections.Add(1) == 1
		if first {
			err = conn.WriteJSON(protocol.ControllerCommandMessage{Type: "command", CommandID: "command", NodeID: "macair", SessionID: "session", Action: protocol.ActionSend, Prompt: "fixture only", ExpiresAt: time.Now().Add(time.Minute).Format(time.RFC3339Nano)})
			if err != nil {
				done <- err
				return
			}
		}
		var accepted protocol.DaemonResultMessage
		if err := conn.ReadJSON(&accepted); err != nil {
			done <- err
			return
		}
		if accepted.Status != protocol.StatusAccepted || accepted.TurnID != "target" {
			done <- fmt.Errorf("bad acceptance: %+v", accepted)
			return
		}
		if first {
			return
		} // Drop the connection before persistence acknowledgement.
		if err := conn.WriteJSON(protocol.ResultAckMessage{Type: "result_ack", CommandID: "command", TurnID: "target", Status: protocol.StatusAccepted}); err != nil {
			done <- err
			return
		}
		if err := conn.WriteJSON(protocol.InspectTurnMessage{Type: "inspect_turn", CommandID: "command", NodeID: "macair", SessionID: "session", TurnID: "target"}); err != nil {
			done <- err
			return
		}
		var result protocol.DaemonResultMessage
		if err := conn.ReadJSON(&result); err != nil {
			done <- err
			return
		}
		if result.Status != protocol.StatusCompleted || result.TurnID != "target" || result.Output != "exact turn output" {
			done <- fmt.Errorf("bad reconciliation: %+v", result)
			return
		}
		done <- nil
		// Keep the connection alive until the test cancels the daemon.
		_, _, err = conn.ReadMessage()
		if err == nil {
			t.Log("unexpected message after reconciliation")
		}
	}))
	defer server.Close()
	a := &transportAdapter{inspectingAdapter: inspectingAdapter{status: "completed"}}
	d := NewDaemon(&config.Config{NodeID: "macair", NodeToken: "test", ControllerURL: "ws" + strings.TrimPrefix(server.URL, "http"), HeartbeatInterval: time.Minute}, a)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	exited := make(chan error, 1)
	go func() { exited <- d.Run(ctx) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("timed out waiting for reconnect reconciliation")
	}
	cancel()
	select {
	case <-exited:
	case <-time.After(time.Second):
		t.Fatal("daemon did not stop")
	}
	if a.sends.Load() != 1 {
		t.Fatalf("turn re-dispatched %d times", a.sends.Load())
	}
}
