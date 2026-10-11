package client

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/skills"
	"github.com/gorilla/websocket"
)

func TestControllerPayloadLimitUsesEncodedBytesAndExactBoundary(t *testing.T) {
	const jsonStringQuotes = 2
	for _, extra := range []int{0, 1} {
		input := strings.Repeat("x", protocol.MaxControllerMessageBytes-jsonStringQuotes+extra)
		encoded, err := encodeControllerMessage(input)
		if extra == 0 && (err != nil || len(encoded) != protocol.MaxControllerMessageBytes) {
			t.Fatalf("exact limit rejected: bytes=%d error=%v", len(encoded), err)
		}
		if extra > 0 && (err == nil || encoded != nil) {
			t.Fatal("oversize message retained sendable bytes")
		}
	}
	// JSON escaping expands '<' to six bytes; character count is not wire size.
	if encoded, err := encodeControllerMessage(strings.Repeat("<", protocol.MaxControllerMessageBytes/2)); err == nil || encoded != nil {
		t.Fatal("escaping bypassed message bound")
	}
	if encoded, err := encodeControllerMessage(make(chan int)); err == nil || encoded != nil {
		t.Fatal("encoding error ignored")
	}
}

func TestControllerPayloadRecoverySendsFreshHelloWithoutRestart(t *testing.T) {
	hellos := make(chan protocol.DaemonHelloMessage, 2)
	failures := make(chan error, 2)
	var connections atomic.Int32
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			failures <- err
			return
		}
		defer func() {
			if err := conn.Close(); err != nil {
				t.Logf("fixture close: %v", err)
			}
		}()
		attempt := connections.Add(1)
		if err := conn.SetReadDeadline(time.Now().Add(4 * time.Second)); err != nil {
			failures <- err
			return
		}
		var hello protocol.DaemonHelloMessage
		if err := conn.ReadJSON(&hello); err != nil {
			if attempt != 1 {
				failures <- err
			}
			return
		}
		if attempt == 1 {
			failures <- errors.New("oversized initial inventory was sent")
			return
		}
		hellos <- hello
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer server.Close()
	d := NewDaemon(&config.Config{NodeID: "node", ControllerURL: "ws" + strings.TrimPrefix(server.URL, "http")},
		&refreshFixture{discover: func(context.Context) ([]protocol.Session, error) {
			return []protocol.Session{{ID: "control", Title: "small", ObservedAt: "fresh-control"}}, nil
		}})
	d.sessionCatalog = &catalogFixture{discover: func(context.Context) ([]protocol.Session, error) {
		return []protocol.Session{{ID: "catalog", Title: "small", ObservedAt: "fresh-catalog"}}, nil
	}}
	large := strings.Repeat("x", protocol.MaxControllerMessageBytes/2)
	d.sessionSnapshot = []protocol.Session{{ID: "control", Title: large, ObservedAt: "old-control"}}
	d.catalogSnapshot = []protocol.Session{{ID: "catalog", Title: large, ObservedAt: "old-catalog"}}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	done := make(chan error, 1)
	go func() { done <- d.Run(ctx) }()
	defer func() {
		cancel()
		select {
		case err := <-done:
			if !errors.Is(err, context.Canceled) {
				t.Errorf("unexpected exit: %v", err)
			}
		case <-time.After(time.Second):
			t.Error("recovery workers did not join")
		}
	}()
	select {
	case hello := <-hellos:
		if hello.Type != "hello" || len(hello.Sessions) != 2 || hello.Sessions[0].ObservedAt != "fresh-control" || hello.Sessions[1].ObservedAt != "fresh-catalog" {
			t.Fatalf("recovery sent a partial/stale inventory: %+v", hello)
		}
	case err := <-failures:
		t.Fatal(err)
	case <-ctx.Done():
		t.Fatal("oversized cached hello prevented recovery")
	}
}

func TestControllerPayloadRecoveryPreservesFailedSourcesAndIgnoresNetworkErrors(t *testing.T) {
	var calls atomic.Int32
	failed := func(context.Context) ([]protocol.Session, error) {
		calls.Add(1)
		return []protocol.Session{{ID: "partial", ObservedAt: "new"}}, errors.New("source incomplete")
	}
	d := NewDaemon(&config.Config{}, &refreshFixture{discover: failed})
	d.sessionCatalog = &catalogFixture{discover: failed}
	d.sessionSnapshot = []protocol.Session{{ID: "control", ObservedAt: "old-control"}}
	d.catalogSnapshot = []protocol.Session{{ID: "catalog", ObservedAt: "old-catalog"}}
	before := d.cachedSessions()
	d.recoverControllerPayload(context.Background(), errors.New("network error"))
	if calls.Load() != 0 {
		t.Fatal("ordinary connection error caused recovery scans")
	}
	d.recoverControllerPayload(context.Background(), fmt.Errorf("hello failed: %w", errControllerPayloadLimit))
	if calls.Load() != 2 || !reflect.DeepEqual(before, d.cachedSessions()) {
		t.Fatal("failed recovery replaced original source timestamps or inventory")
	}
}

func TestControllerPayloadRecoveryCancellationJoinsBothSources(t *testing.T) {
	started := make(chan struct{}, 2)
	var active atomic.Int32
	blocked := func(ctx context.Context) ([]protocol.Session, error) {
		active.Add(1)
		defer active.Add(-1)
		started <- struct{}{}
		<-ctx.Done()
		return nil, ctx.Err()
	}
	d := NewDaemon(&config.Config{}, &refreshFixture{discover: blocked})
	d.sessionCatalog = &catalogFixture{discover: blocked}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); d.recoverControllerPayload(ctx, errControllerPayloadLimit) }()
	for i := 0; i < 2; i++ {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("recovery did not start sources in parallel")
		}
	}
	cancel()
	select {
	case <-done:
		if active.Load() != 0 {
			t.Fatal("recovery returned before joining sources")
		}
	case <-time.After(time.Second):
		t.Fatal("recovery did not honor cancellation")
	}
}

func TestControllerPayloadLimitCoversMergedInventoryAndSkills(t *testing.T) {
	metadata := strings.Repeat("x", protocol.MaxControllerMessageBytes/2)
	control := []protocol.Session{{ID: "control", Title: metadata}}
	catalog := []protocol.Session{{ID: "catalog", Title: metadata}}
	for _, sessions := range [][]protocol.Session{control, catalog} {
		if _, err := encodeControllerMessage(protocol.DaemonHeartbeatMessage{Type: "heartbeat", Sessions: sessions}); err != nil {
			t.Fatalf("individual source should fit: %v", err)
		}
	}
	message := protocol.DaemonHeartbeatMessage{Type: "heartbeat", Sessions: mergeSessionSources(control, catalog), Skills: []skills.Skill{{Name: "skill"}}}
	if encoded, err := encodeControllerMessage(message); err == nil || encoded != nil {
		t.Fatal("combined sources bypassed message limit")
	}
	if len(message.Sessions) != 2 || len(message.Sessions[0].Title) != len(metadata) {
		t.Fatal("oversized inventory silently truncated")
	}
	message.Sessions = nil
	message.Skills = []skills.Skill{{Name: metadata + metadata}}
	if _, err := encodeControllerMessage(message); err == nil {
		t.Fatal("skills excluded from complete frame bound")
	}
	message.Skills = nil
	encoded, err := encodeControllerMessage(message)
	if err != nil || !json.Valid(encoded) {
		t.Fatalf("normal heartbeat broken: %v", err)
	}
}
