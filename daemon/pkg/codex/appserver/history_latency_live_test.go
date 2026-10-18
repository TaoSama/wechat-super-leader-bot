package appserver

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

// Opt-in timing of an existing native socket. This sends only initialize,
// loaded-list discovery, metadata and bounded items reads; no bodies or target
// identities are logged, and no thread is resumed or changed.
func TestLiveHistoryFirstPageLatency(t *testing.T) {
	socket := os.Getenv("CODEX_APP_SERVER_SOCKET")
	if os.Getenv("LIVE_CODEX_HISTORY_LATENCY") != "1" || socket == "" {
		t.Skip("requires LIVE_CODEX_HISTORY_LATENCY=1 and an explicit existing CODEX_APP_SERVER_SOCKET")
	}
	const pageSize = 20
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	adapter := NewAppServerAdapter(socket)
	started := time.Now()
	rc, err := adapter.connect(ctx)
	if err != nil {
		t.Fatal("existing native socket could not initialize")
	}
	defer rc.closeLogged()
	t.Logf("stage=initialize elapsed_ms=%.2f", float64(time.Since(started).Microseconds())/1000)
	sessionID := os.Getenv("LIVE_CODEX_HISTORY_SESSION")
	if sessionID == "" {
		started = time.Now()
		loaded, err := rc.call(ctx, "thread/loaded/list", map[string]any{"limit": 1}, adapter.rpcTimeout)
		if err != nil {
			t.Fatal("read-only target discovery failed")
		}
		data, ok := loaded["data"].([]any)
		if !ok || len(data) == 0 {
			t.Skip("no already-loaded target; provide LIVE_CODEX_HISTORY_SESSION explicitly")
		}
		sessionID, ok = data[0].(string)
		if !ok {
			t.Fatal("native loaded target has invalid identity")
		}
		t.Logf("stage=target-discovery elapsed_ms=%.2f", float64(time.Since(started).Microseconds())/1000)
	}
	if !protocol.ValidHistoryIdentity(sessionID) {
		t.Fatal("invalid native target identity")
	}
	stages := []struct {
		method string
		params map[string]any
	}{
		{"thread/loaded/list", map[string]any{}},
		{"thread/read", map[string]any{"threadId": sessionID, "includeTurns": false}},
		{"thread/items/list", map[string]any{"threadId": sessionID, "sortDirection": "desc", "limit": pageSize}},
	}
	for _, stage := range stages {
		started = time.Now()
		result, err := rc.call(ctx, stage.method, stage.params, adapter.rpcTimeout)
		if err != nil {
			t.Fatalf("stage=%s native read failed", stage.method)
		}
		encoded, err := json.Marshal(result)
		if err != nil {
			t.Fatalf("stage=%s native response could not encode", stage.method)
		}
		t.Logf("stage=%s elapsed_ms=%.2f response_bytes=%d", stage.method, float64(time.Since(started).Microseconds())/1000, len(encoded))
	}
	for attempt := range 3 {
		started = time.Now()
		history, err := adapter.ReadHistory(ctx, sessionID, "", pageSize)
		if err != nil {
			t.Fatal("bounded native first-page read failed")
		}
		encoded, err := json.Marshal(history)
		if err != nil || history.Session.ID != sessionID || len(history.Items) > pageSize || len(encoded) >= protocol.MaxHistoryResponseBytes {
			t.Fatal("native first-page identity or size contract failed")
		}
		t.Logf("stage=first-page attempt=%d elapsed_ms=%.2f items=%d response_bytes=%d has_older=%t", attempt+1, float64(time.Since(started).Microseconds())/1000, len(history.Items), len(encoded), history.NextCursor != nil)
	}
}
