package client

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/appserver"
	codexdesktop "github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/desktop"
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
	err := codexdesktop.NewDesktopObserver(path).Watch(ctx, []string{sessionID}, func(id string, observation protocol.DesktopObservation) {
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

// This opt-in check reads existing control and desktop sockets. It never loads,
// resumes or sends to the target, and reports only exact-match booleans/statuses.
func TestLiveHistoryExactDesktopOwnerOverlay(t *testing.T) {
	control, desktopPath, sessionID := os.Getenv("CODEX_APP_SERVER_SOCKET"), os.Getenv("LIVE_CODEX_DESKTOP_SOCKET"), os.Getenv("LIVE_CODEX_DESKTOP_SESSION")
	if os.Getenv("LIVE_CODEX_HISTORY_OWNER_OVERLAY") != "1" || control == "" || desktopPath == "" || sessionID == "" {
		t.Skip("requires explicit existing sockets/session and LIVE_CODEX_HISTORY_OWNER_OVERLAY=1")
	}
	const nodeID = "readonly-owner-overlay-acceptance"
	adapter := appserver.NewAppServerAdapter(control)
	d := NewDaemon(&config.Config{NodeID: nodeID}, adapter)
	t.Cleanup(func() {
		if err := d.Close(); err != nil {
			t.Error(err)
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	native, err := adapter.ReadHistory(ctx, sessionID, "", protocol.DefaultHistoryLimit)
	if err != nil {
		t.Fatal("native bounded history could not be read")
	}
	watchCtx, stopWatch := context.WithCancel(ctx)
	defer stopWatch()
	var proof protocol.DesktopObservation
	err = codexdesktop.NewDesktopObserver(desktopPath).Watch(watchCtx, []string{sessionID}, func(_ string, observation protocol.DesktopObservation) {
		if observation.Availability == "available" && observation.Status == "active" && protocol.ValidTurnID(observation.ActiveTurnID) {
			proof = observation
			stopWatch()
		}
	})
	if err != nil && proof.ActiveTurnID == "" {
		t.Fatal("existing desktop owner could not establish exact active-turn proof")
	}
	if proof.ActiveTurnID == "" {
		t.Skip("existing target does not currently expose a unique active owner turn")
	}
	d.desktopSnapshot[sessionID] = proof
	response := d.ReadHistory(ctx, protocol.ReadHistoryMessage{Type: "read_history", NodeID: nodeID, SessionID: sessionID, RequestID: "readonly-owner-overlay", Limit: protocol.DefaultHistoryLimit})
	if response.Error != "" || response.History == nil || response.History.Session.ID != sessionID || response.History.Source != protocol.HistorySourceControl || response.History.TurnStatuses[proof.ActiveTurnID] != "inProgress" {
		t.Fatal("routed history did not honor the exact fresh active desktop owner")
	}
	nativeStatus := native.TurnStatuses[proof.ActiveTurnID]
	if nativeStatus == "" {
		nativeStatus = "unknown"
	}
	unchangedCompleted := 0
	for turnID, status := range native.TurnStatuses {
		if turnID == proof.ActiveTurnID || status != "completed" {
			continue
		}
		if response.History.TurnStatuses[turnID] != "completed" {
			t.Fatal("an unrelated completed native turn changed during exact owner overlay")
		}
		unchangedCompleted++
	}
	if unchangedCompleted == 0 {
		t.Fatal("choose an existing active target with recorded completed turns to verify isolation")
	}
	t.Logf("exact_owner_turn=true native_recorded_status=%s final_history_status=inProgress unrelated_completed_unchanged=%d readonly_calls=true", nativeStatus, unchangedCompleted)
}
