package client

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/gorilla/websocket"
)

func TestControllerHelloNegotiatesSteerBeforeExactTurnDelivery(t *testing.T) {
	const timeout = 5 * time.Second
	completed := make(chan error, 1)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			completed <- err
			return
		}
		defer func() {
			if err := conn.Close(); err != nil {
				t.Logf("fixture connection cleanup: %v", err)
			}
		}()
		if err := conn.SetReadDeadline(time.Now().Add(timeout)); err != nil {
			completed <- err
			return
		}
		var hello struct {
			Type          string                  `json:"type"`
			DeliveryModes []protocol.DeliveryMode `json:"deliveryModes"`
		}
		if err := conn.ReadJSON(&hello); err != nil {
			completed <- err
			return
		}
		if hello.Type != "hello" || !slices.Contains(hello.DeliveryModes, protocol.DeliverySteer) ||
			!slices.Contains(hello.DeliveryModes, protocol.DeliveryNextTurn) {
			completed <- fmt.Errorf("hello did not advertise supported delivery modes: %+v", hello)
			return
		}
		cmd := persistenceCommand(time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano))
		cmd.SendRoute, cmd.DeliveryMode, cmd.ExpectedTurnID = protocol.RouteControlSocket, protocol.DeliverySteer, "active-turn"
		if err := conn.WriteJSON(cmd); err != nil {
			completed <- err
			return
		}
		var result protocol.DaemonResultMessage
		if err := conn.ReadJSON(&result); err != nil {
			completed <- err
			return
		}
		if result.CommandID != cmd.CommandID || result.Status != protocol.StatusAccepted || result.TurnID != cmd.ExpectedTurnID {
			completed <- fmt.Errorf("negotiated steer lost exact turn binding: %+v", result)
			return
		}
		completed <- nil
		if _, _, err := conn.ReadMessage(); err == nil {
			t.Error("unexpected message after steer acceptance")
		}
	}))
	defer server.Close()
	a := &steerReceiptAdapter{turnID: "active-turn"}
	d := NewDaemon(&config.Config{NodeID: "macair", ControllerURL: "ws" + strings.TrimPrefix(server.URL, "http")}, a)
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	exited := make(chan error, 1)
	go func() { exited <- d.Run(ctx) }()
	defer func() {
		cancel()
		select {
		case err := <-exited:
			if !errors.Is(err, ctx.Err()) {
				t.Errorf("unexpected daemon exit: %v", err)
			}
		case <-time.After(time.Second):
			t.Error("fixture daemon did not join")
		}
	}()
	select {
	case err := <-completed:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for negotiated steer")
	}
	if a.steers.Load() != 1 || a.sends.Load() != 0 {
		t.Fatalf("steers=%d new turns=%d", a.steers.Load(), a.sends.Load())
	}
}
