package client

import (
	"context"
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
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/skills"
	"github.com/gorilla/websocket"
)

type refreshFixture struct {
	discover func(context.Context) ([]protocol.Session, error)
}

func (a *refreshFixture) DiscoverSessions(ctx context.Context) ([]protocol.Session, error) {
	return a.discover(ctx)
}
func (a *refreshFixture) ReadSession(context.Context, string) (string, error) {
	return "fixture output", nil
}
func (a *refreshFixture) SendPrompt(context.Context, string, string) (string, error) {
	return "", errors.New("fixture never sends")
}
func (a *refreshFixture) ReadHistory(context.Context, string, string, int) (protocol.SessionHistory, error) {
	return protocol.SessionHistory{Session: protocol.Session{ID: "session"}, Items: []protocol.HistoryItem{}}, nil
}

func TestRefreshObservationsFailureAndMetadataChanges(t *testing.T) {
	calls := make(chan int, 8)
	var count atomic.Int32
	a := &refreshFixture{discover: func(ctx context.Context) ([]protocol.Session, error) {
		n := int(count.Add(1))
		calls <- n
		s := protocol.Session{ID: "session", Status: "idle", Model: "old", ObservedAt: fmt.Sprintf("observed-%d", n)}
		switch n {
		case 1, 2:
			return []protocol.Session{s}, nil
		case 3:
			return nil, errors.New("PRIVATE_UPSTREAM_DETAIL")
		case 4:
			s.Status, s.Model = "busy", "new"
			return []protocol.Session{s, {ID: "new-session"}}, nil
		default:
			<-ctx.Done()
			return nil, ctx.Err()
		}
	}}
	d := NewDaemon(&config.Config{}, a)
	ctx, cancel := context.WithCancel(context.Background())
	updates, done := make(chan struct{}, 1), make(chan struct{})
	go func() { defer close(done); d.refreshSessions(ctx, updates) }()
	defer func() {
		cancel()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("discovery did not stop")
		}
	}()
	awaitUpdate := func() {
		t.Helper()
		select {
		case <-updates:
		case <-time.After(3 * time.Second):
			t.Fatal("change not published on discovery cadence")
		}
	}
	awaitUpdate()
	if snapshot := d.cachedSessions(); len(snapshot) != 1 || snapshot[0].ObservedAt != "observed-1" {
		t.Fatalf("initial snapshot: %+v", snapshot)
	}
	for n := 1; n <= 3; n++ {
		select {
		case got := <-calls:
			if got != n {
				t.Fatalf("call=%d want=%d", got, n)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("discovery cadence stalled")
		}
	}
	// Synchronize after the failing call without relying on the call-start notification.
	deadline := time.Now().Add(time.Second)
	for d.cachedSessions()[0].ObservedAt != "observed-2" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if got := d.cachedSessions(); got[0].ObservedAt != "observed-2" || got[0].Status != "idle" {
		t.Fatalf("failure replaced successful observation: %+v", got)
	}
	select {
	case <-updates:
		t.Fatal("observation/failure triggered update")
	default:
	}
	awaitUpdate()
	if got := d.cachedSessions(); len(got) != 2 || got[0].Status != "busy" || got[0].Model != "new" {
		t.Fatalf("metadata/collection not refreshed: %+v", got)
	}
}

func TestBlockedDiscoveryKeepsHelloHeartbeatCommandHistoryAndCancels(t *testing.T) {
	var calls, active, maximum, canceled atomic.Int32
	started := make(chan struct{}, 1)
	a := &refreshFixture{discover: func(ctx context.Context) ([]protocol.Session, error) {
		calls.Add(1)
		n := active.Add(1)
		maximum.Store(n)
		defer active.Add(-1)
		started <- struct{}{}
		<-ctx.Done()
		canceled.Add(1)
		return nil, ctx.Err()
	}}
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
				t.Logf("fixture close: %v", err)
			}
		}()
		if err := conn.SetReadDeadline(time.Now().Add(4 * time.Second)); err != nil {
			completed <- err
			return
		}
		var hello protocol.DaemonHelloMessage
		if err := conn.ReadJSON(&hello); err != nil {
			completed <- err
			return
		}
		if hello.Type != "hello" || len(hello.Sessions) != 0 {
			completed <- errors.New("hello did not use unobserved cache")
			return
		}
		select {
		case <-started:
		case <-time.After(time.Second):
			completed <- errors.New("discovery not started")
			return
		}
		command := protocol.ControllerCommandMessage{Type: "command", NodeID: "node", SessionID: "session", CommandID: "read", Action: protocol.ActionRead, ExpiresAt: time.Now().Add(time.Minute).Format(time.RFC3339Nano)}
		if err := conn.WriteJSON(command); err != nil {
			completed <- err
			return
		}
		if err := conn.WriteJSON(protocol.ReadHistoryMessage{Type: "read_history", NodeID: "node", SessionID: "session", RequestID: "history"}); err != nil {
			completed <- err
			return
		}
		heartbeat, commandDone, historyDone := false, false, false
		for !heartbeat || !commandDone || !historyDone {
			var frame map[string]any
			if err := conn.ReadJSON(&frame); err != nil {
				completed <- err
				return
			}
			switch frame["type"] {
			case "heartbeat":
				heartbeat = true
			case "result":
				commandDone = frame["commandId"] == "read" && frame["status"] == "completed"
			case "history":
				historyDone = frame["requestId"] == "history" && frame["error"] == nil
			}
		}
		// Remain blocked across a discovery tick; only one adapter call may exist.
		timer := time.NewTimer(sessionRefreshInterval + 50*time.Millisecond)
		defer timer.Stop()
		<-timer.C
		completed <- nil
	}))
	defer server.Close()
	d := NewDaemon(&config.Config{NodeID: "node", ControllerURL: "ws" + strings.TrimPrefix(server.URL, "http"), HeartbeatInterval: 20 * time.Millisecond}, a)
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	exited := make(chan error, 1)
	go func() { exited <- d.runOnce(ctx) }()
	select {
	case err := <-completed:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("blocked discovery stalled transport")
	}
	select {
	case <-exited:
	case <-time.After(time.Second):
		t.Fatal("connection did not join canceled discovery")
	}
	if calls.Load() != 1 || maximum.Load() != 1 || canceled.Load() != 1 || active.Load() != 0 {
		t.Fatalf("discovery not single-flight/cleaned: calls=%d max=%d canceled=%d active=%d", calls.Load(), maximum.Load(), canceled.Load(), active.Load())
	}
}

func TestChangedHeartbeatsUseCachedSkillsWhileScanBlocked(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cache := &skillCatalogCache{catalog: []skills.Skill{{Name: "old"}}}
	requests, updates := make(chan struct{}, 1), make(chan struct{}, 1)
	started, release, scanDone := make(chan struct{}), make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
		cancel()
		select {
		case <-scanDone:
		case <-time.After(time.Second):
			t.Error("scan worker cleanup stalled")
		}
	}()
	var scans atomic.Int32
	go func() {
		defer close(scanDone)
		refreshSkillCatalog(ctx, requests, cache, func() []skills.Skill { scans.Add(1); close(started); <-release; return []skills.Skill{{Name: "new"}} })
	}()
	requests <- struct{}{}
	<-started
	frames := make(chan protocol.DaemonHeartbeatMessage, 16)
	d := NewDaemon(&config.Config{HeartbeatInterval: 20 * time.Millisecond}, &refreshFixture{})
	heartbeatDone := make(chan error, 1)
	go func() {
		heartbeatDone <- d.heartbeatLoop(ctx, updates, requests, cache.snapshot, func(message any) error { frames <- message.(protocol.DaemonHeartbeatMessage); return nil })
	}()
	updates <- struct{}{}
	for i := 0; i < 3; i++ {
		select {
		case frame := <-frames:
			if len(frame.Skills) != 1 || frame.Skills[0].Name != "old" {
				t.Fatalf("cache not retained: %+v", frame)
			}
		case <-time.After(time.Second):
			t.Fatal("skill scan blocked heartbeat")
		}
	}
	if scans.Load() != 1 || len(requests) != 0 {
		t.Fatal("fast heartbeat rescanned skills")
	}
	close(release)
	deadline := time.Now().Add(time.Second)
	for cache.snapshot()[0].Name != "new" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if cache.snapshot()[0].Name != "new" {
		t.Fatal("scan did not update cache")
	}
	cancel()
	select {
	case err := <-heartbeatDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("heartbeat did not stop")
	}
	select {
	case <-scanDone:
	case <-time.After(time.Second):
		t.Fatal("scan worker did not stop")
	}
}

func TestSessionChangesSendHeartbeatBeforeRegularDeadline(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	updates, requests := make(chan struct{}, 1), make(chan struct{}, 1)
	frames := make(chan protocol.DaemonHeartbeatMessage, 4)
	d := NewDaemon(&config.Config{HeartbeatInterval: time.Hour}, &refreshFixture{})
	cache := &skillCatalogCache{}
	done := make(chan error, 1)
	go func() {
		done <- d.heartbeatLoop(ctx, updates, requests, cache.snapshot, func(message any) error { frames <- message.(protocol.DaemonHeartbeatMessage); return nil })
	}()
	defer func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(time.Second):
			t.Error("heartbeat cleanup stalled")
		}
	}()
	for _, snapshot := range [][]protocol.Session{
		{{ID: "session", Status: "idle", Model: "old"}},
		{{ID: "session", Status: "busy", Model: "old"}},
		{{ID: "session", Status: "busy", Model: "new"}},
		{},
	} {
		d.snapshotMu.Lock()
		d.sessionSnapshot = cloneSessions(snapshot)
		d.snapshotMu.Unlock()
		updates <- struct{}{}
		select {
		case frame := <-frames:
			if frame.Type != "heartbeat" || sessionsChanged(frame.Sessions, snapshot) {
				t.Fatalf("changed snapshot not reported: %+v", frame)
			}
		case <-time.After(time.Second):
			t.Fatal("change waited for regular heartbeat")
		}
	}
	if len(requests) != 0 {
		t.Fatal("changed heartbeat scheduled skill scan")
	}
}
