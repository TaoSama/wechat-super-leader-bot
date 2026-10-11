package client

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

// This exact-target, read-only check starts with the same ownerless placeholder
// as a cold daemon. It never resumes a thread or opens a command journal.
func TestLiveDesktopHistoryColdRoute(t *testing.T) {
	path, sessionID := os.Getenv("LIVE_CODEX_DESKTOP_SOCKET"), os.Getenv("LIVE_CODEX_DESKTOP_SESSION")
	if path == "" || sessionID == "" || os.Getenv("LIVE_CODEX_DESKTOP_HISTORY") != "1" {
		t.Skip("requires explicit socket, session and LIVE_CODEX_DESKTOP_HISTORY=1")
	}
	const nodeID = "readonly-history-acceptance"
	d := NewDaemon(&config.Config{NodeID: nodeID, DesktopSocketPath: path}, rejectLiveNativeFallback{})
	defer func() {
		if err := d.Close(); err != nil {
			t.Error(err)
		}
	}()
	loaded := false
	d.sessionSnapshot = []protocol.Session{{ID: sessionID, Status: "notLoaded", Loaded: &loaded}}
	updates := make(chan struct{}, 1)
	d.publishDesktop(sessionID, protocol.DesktopObservation{Status: "unknown", Availability: "unavailable", Source: protocol.HistorySourceDesktop}, updates)
	if d.preferredHistorySource(sessionID) != protocol.HistorySourceControl {
		t.Fatal("ownerless placeholder selected desktop")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	stateAvailable := false
	err := codex.NewDesktopObserver(path).Watch(ctx, []string{sessionID}, func(id string, observation protocol.DesktopObservation) {
		d.publishDesktop(id, observation, updates)
		if observation.Availability == "available" {
			stateAvailable = true
			cancel()
		}
	})
	cancel()
	if err != nil && !stateAvailable {
		d.invalidateDesktop(updates)
		t.Log("state snapshot unavailable; checking whether validated owner discovery survived")
	}
	if d.preferredHistorySource(sessionID) != protocol.HistorySourceDesktop {
		t.Fatal("exact owner discovery did not establish desktop history route")
	}
	request := protocol.ReadHistoryMessage{Type: "read_history", RequestID: "readonly-latest", NodeID: nodeID, SessionID: sessionID, Limit: 3}
	read := func() protocol.SessionHistory {
		t.Helper()
		result := d.ReadHistory(context.Background(), request)
		if result.Error != "" || result.History == nil {
			t.Fatalf("routed history failed: %s", result.Error)
		}
		h := *result.History
		if h.Source != protocol.HistorySourceDesktop || h.HistoryContext == "" || h.Session.ID != sessionID || h.Session.Loaded == nil || *h.Session.Loaded || h.Session.Status != "notLoaded" {
			t.Fatal("history route/identity/native state changed")
		}
		return h
	}
	first := read()
	if first.NextCursor == nil {
		t.Fatal("choose an existing target with enough history for paging")
	}
	request.RequestID, request.HistoryContext, request.Cursor = "readonly-older", first.HistoryContext, *first.NextCursor
	older := read()
	seen := make(map[string]bool)
	for _, item := range first.Items {
		seen[item.ID] = true
	}
	for _, item := range older.Items {
		if seen[item.ID] {
			t.Fatal("older page overlaps latest")
		}
	}
	request.RequestID, request.Cursor = "readonly-refresh", ""
	latest := read()
	if older.HistoryContext != first.HistoryContext || latest.HistoryContext != first.HistoryContext {
		t.Fatal("paging or refresh silently changed context")
	}
	t.Logf("cold route: source=%s first=%d older=%d latest=%d; stable context; native loaded=false preserved; no send or journal", first.Source, len(first.Items), len(older.Items), len(latest.Items))
}
