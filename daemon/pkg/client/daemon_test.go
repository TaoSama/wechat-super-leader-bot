package client_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/client"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/gorilla/websocket"
)

type mockAdapter struct {
	mu           sync.Mutex
	sessions     []protocol.Session
	readOutputs  map[string]string
	sendAcks     map[string]string
	sendErrors   map[string]error
	readCalls    []string
	sendCalls    []string
	delayPerCall time.Duration
}

func (m *mockAdapter) DiscoverSessions(ctx context.Context) ([]protocol.Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions, nil
}

func (m *mockAdapter) ReadSession(ctx context.Context, sessionID string) (string, error) {
	m.mu.Lock()
	m.readCalls = append(m.readCalls, sessionID)
	out := m.readOutputs[sessionID]
	delay := m.delayPerCall
	m.mu.Unlock()

	if delay > 0 {
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	return out, nil
}

func (m *mockAdapter) SendPrompt(ctx context.Context, sessionID string, prompt string) (string, error) {
	m.mu.Lock()
	m.sendCalls = append(m.sendCalls, sessionID+":"+prompt)
	ack := m.sendAcks[sessionID]
	err := m.sendErrors[sessionID]
	delay := m.delayPerCall
	m.mu.Unlock()

	if delay > 0 {
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	return ack, err
}

func TestDaemon_ExecuteCommand_DedupeAndPayloadTamper(t *testing.T) {
	mock := &mockAdapter{
		readOutputs: map[string]string{"sess-1": "output from sess-1"},
	}
	cfg := &config.Config{NodeID: "demoair"}
	d := client.NewDaemon(cfg, mock)

	now := time.Now().UTC()
	future := now.Add(1 * time.Minute).Format(time.RFC3339Nano)

	cmd := protocol.ControllerCommandMessage{
		Type:      "command",
		CommandID: "cmd-100",
		NodeID:    "demoair",
		SessionID: "sess-1",
		Action:    protocol.ActionRead,
		ExpiresAt: future,
	}

	// 1. First execution succeeds
	res1 := d.ExecuteCommand(context.Background(), cmd)
	if res1.Status != protocol.StatusCompleted || res1.Output != "output from sess-1" {
		t.Fatalf("res1 failed: %+v", res1)
	}

	// 2. Duplicate exact execution returns cached result without re-executing adapter
	res2 := d.ExecuteCommand(context.Background(), cmd)
	if res2.Status != protocol.StatusCompleted || res2.Output != "output from sess-1" {
		t.Fatalf("res2 failed: %+v", res2)
	}
	if len(mock.readCalls) != 1 {
		t.Fatalf("expected adapter to be called only once, got %d calls", len(mock.readCalls))
	}

	// 3. Duplicate commandId with conflicting payload (e.g. changed action or session) is rejected
	tamperedCmd := cmd
	tamperedCmd.Action = protocol.ActionSend
	tamperedCmd.Prompt = "evil prompt"

	resTampered := d.ExecuteCommand(context.Background(), tamperedCmd)
	if resTampered.Status != protocol.StatusFailed || !strings.Contains(resTampered.Error, "conflicting payload parameters") {
		t.Fatalf("expected tampered command to be rejected, got %+v", resTampered)
	}
}

func TestDaemon_ExecuteCommand_SessionSerialization(t *testing.T) {
	mock := &mockAdapter{
		readOutputs:  map[string]string{"sess-1": "data"},
		delayPerCall: 50 * time.Millisecond,
	}
	cfg := &config.Config{NodeID: "demoair"}
	d := client.NewDaemon(cfg, mock)

	future := time.Now().UTC().Add(1 * time.Minute).Format(time.RFC3339Nano)

	// Dispatch 2 concurrent commands to the same session
	var wg sync.WaitGroup
	wg.Add(2)

	start := time.Now()
	go func() {
		defer wg.Done()
		d.ExecuteCommand(context.Background(), protocol.ControllerCommandMessage{
			Type:      "command",
			CommandID: "cmd-seq-1",
			NodeID:    "demoair",
			SessionID: "sess-1",
			Action:    protocol.ActionRead,
			ExpiresAt: future,
		})
	}()

	go func() {
		defer wg.Done()
		d.ExecuteCommand(context.Background(), protocol.ControllerCommandMessage{
			Type:      "command",
			CommandID: "cmd-seq-2",
			NodeID:    "demoair",
			SessionID: "sess-1",
			Action:    protocol.ActionRead,
			ExpiresAt: future,
		})
	}()

	wg.Wait()
	elapsed := time.Since(start)

	// Since each call takes 50ms and they target the same session, elapsed must be >= 90ms
	if elapsed < 90*time.Millisecond {
		t.Fatalf("expected serialized execution to take >= 90ms, took %v", elapsed)
	}
}

func TestDaemon_Run_HelloAndHeartbeatFlow(t *testing.T) {
	var upgrader = websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool { return true },
	}

	receivedMsgs := make(chan map[string]any, 10)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify authorization header
		if r.Header.Get("Authorization") != "Bearer secret-token-123" {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		for {
			var raw map[string]any
			if err := conn.ReadJSON(&raw); err != nil {
				return
			}
			receivedMsgs <- raw
		}
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")

	cfg := &config.Config{
		NodeID:            "demoair",
		ControllerURL:     wsURL,
		NodeToken:         "secret-token-123",
		HeartbeatInterval: 50 * time.Millisecond,
	}

	mock := &mockAdapter{
		sessions: []protocol.Session{
			{
				ID:           "test-sess-1",
				Provider:     "codex-app",
				Title:        "My Session",
				Status:       "idle",
				Capabilities: []protocol.ActionType{protocol.ActionRead, protocol.ActionSend},
				ObservedAt:   time.Now().UTC().Format(time.RFC3339Nano),
			},
		},
	}

	d := client.NewDaemon(cfg, mock)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() {
		_ = d.Run(ctx)
	}()

	// 1. Verify Hello message received
	select {
	case msg := <-receivedMsgs:
		if msg["type"] != "hello" || msg["nodeId"] != "demoair" {
			t.Fatalf("expected hello message, got %+v", msg)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("timeout waiting for hello message")
	}

	// 2. Verify Heartbeat message received
	select {
	case msg := <-receivedMsgs:
		if msg["type"] != "heartbeat" {
			t.Fatalf("expected heartbeat message, got %+v", msg)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("timeout waiting for heartbeat message")
	}
}
