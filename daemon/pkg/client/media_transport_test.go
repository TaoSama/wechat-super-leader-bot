package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/gorilla/websocket"
)

type mediaTransportFixture struct {
	mediaFixture
	started, canceled chan struct{}
}

func (f *mediaTransportFixture) ListSessionMedia(ctx context.Context, sessionID, generation, itemID, turnID string, limit int) ([]protocol.NativeMediaReference, string, error) {
	if sessionID == "cancel-session" {
		close(f.started)
		<-ctx.Done()
		close(f.canceled)
		return nil, "", ctx.Err()
	}
	return f.mediaFixture.ListSessionMedia(ctx, sessionID, generation, itemID, turnID, limit)
}

func readMediaWire(conn *websocket.Conn, kind string, result any) error {
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		var header struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(raw, &header); err != nil {
			return err
		}
		if header.Type == kind {
			return json.Unmarshal(raw, result)
		}
		if header.Type != "heartbeat" {
			return errors.New("unexpected media transport message")
		}
	}
}

func TestMediaControllerConnectionListsReadsCancelsAndExpiresOnDisconnect(t *testing.T) {
	path := mediaFixturePath(t)
	want := mediaPNG(t, path, 48)
	fixture := &mediaTransportFixture{mediaFixture: mediaFixture{generation: "owner", refs: []protocol.NativeMediaReference{{ItemID: "item", TurnID: "turn", Path: path}}}, started: make(chan struct{}), canceled: make(chan struct{})}
	done := make(chan error, 1)
	var listing protocol.DaemonMediaListMessage
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			done <- err
			return
		}
		defer func() {
			if err := conn.Close(); err != nil {
				t.Logf("close media fixture: %v", err)
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
		if err := conn.WriteJSON(protocol.ListMediaMessage{Type: "list_media", RequestID: "list", NodeID: "node", SessionID: "session"}); err != nil {
			done <- err
			return
		}
		if err := readMediaWire(conn, "media_list", &listing); err != nil {
			done <- err
			return
		}
		if listing.Error != "" || len(listing.Media) != 1 {
			done <- errors.New("list_media was not routed")
			return
		}
		if err := conn.WriteJSON(mediaReadRequest(listing)); err != nil {
			done <- err
			return
		}
		var chunk protocol.DaemonMediaChunkMessage
		if err := readMediaWire(conn, "media_chunk", &chunk); err != nil {
			done <- err
			return
		}
		if chunk.Error != "" || !chunk.EOF || !bytes.Equal(chunk.Data, want) {
			done <- errors.New("read_media did not return exact image")
			return
		}
		if err := conn.WriteJSON(protocol.ListMediaMessage{Type: "list_media", RequestID: "cancel", NodeID: "node", SessionID: "cancel-session"}); err != nil {
			done <- err
			return
		}
		select {
		case <-fixture.started:
		case <-time.After(time.Second):
			done <- errors.New("media worker did not start")
			return
		}
		if err := conn.WriteJSON(protocol.CancelHistoryMessage{Type: "cancel_media", RequestID: "cancel", NodeID: "node", SessionID: "cancel-session"}); err != nil {
			done <- err
			return
		}
		select {
		case <-fixture.canceled:
		case <-time.After(time.Second):
			done <- errors.New("cancel_media was not routed")
			return
		}
		done <- nil
	}))
	defer server.Close()
	d := NewDaemon(&config.Config{NodeID: "node", NodeToken: "fixture", ControllerURL: "ws" + strings.TrimPrefix(server.URL, "http"), HeartbeatInterval: time.Second}, fixture)
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
		t.Fatal(ctx.Err())
	}
	select {
	case <-exited:
	case <-ctx.Done():
		t.Fatal("connection cleanup blocked")
	}
	if got := d.ReadMedia(context.Background(), mediaReadRequest(listing)); got.Error != protocol.MediaContextExpired {
		t.Fatal("disconnected media token remained valid")
	}
	if len(d.outbox) != 0 || len(d.dedupeCache) != 0 || len(d.inFlight) != 0 || len(d.historyRequests.pending) != 0 {
		t.Fatal("media operation left command receipts or pending requests")
	}
}
