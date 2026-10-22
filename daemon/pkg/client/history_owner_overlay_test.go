package client

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestHistoryExactFreshActiveOwnerOutranksOnlyMatchingPersistedTurn(t *testing.T) {
	now := time.Now()
	base := protocol.DesktopObservation{Source: protocol.HistorySourceDesktop, Status: "active", Availability: "available", ObservedAt: now.UTC().Format(time.RFC3339Nano), OwnerID: "owner", ActiveTurnID: "current"}
	for _, tc := range []struct {
		name     string
		modify   func(*protocol.DesktopObservation)
		override bool
	}{
		{"same exact ID", func(*protocol.DesktopObservation) {}, true},
		{"other active turn", func(o *protocol.DesktopObservation) { o.ActiveTurnID = "other" }, false},
		{"stale", func(o *protocol.DesktopObservation) {
			o.ObservedAt = now.Add(-2 * protocol.MaxSendAvailabilityAge).UTC().Format(time.RFC3339Nano)
		}, false},
		{"future", func(o *protocol.DesktopObservation) {
			o.ObservedAt = now.Add(time.Minute).UTC().Format(time.RFC3339Nano)
		}, false},
		{"disconnected", func(o *protocol.DesktopObservation) { o.Availability = "unavailable" }, false},
		{"idle", func(o *protocol.DesktopObservation) { o.Status = "idle" }, false},
		{"unknown exact ID", func(o *protocol.DesktopObservation) { o.ActiveTurnID = "" }, false},
		{"invalid owner", func(o *protocol.DesktopObservation) { o.OwnerID = "invalid owner" }, false},
		{"other source", func(o *protocol.DesktopObservation) { o.Source = protocol.HistorySourceControl }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := NewDaemon(&config.Config{NodeID: "node"}, &historyFixture{})
			observation := base
			tc.modify(&observation)
			d.desktopSnapshot["session"] = observation
			history := protocol.SessionHistory{Items: []protocol.HistoryItem{{ID: "one", TurnID: "current", TurnStatus: "interrupted"}, {ID: "two", TurnID: "old", TurnStatus: "completed"}}, TurnStatuses: map[string]string{"current": "interrupted", "old": "completed"}}
			d.overlayDesktopActiveHistory("session", &history)
			want := "interrupted"
			if tc.override {
				want = "inProgress"
			}
			if history.Items[0].TurnStatus != want || history.Items[1].TurnStatus != "completed" || history.TurnStatuses["current"] != want || history.TurnStatuses["old"] != "completed" {
				t.Fatal("owner proof changed a different turn or ignored exact precedence")
			}
		})
	}
	encoded, err := json.Marshal(base)
	if err != nil || strings.Contains(string(encoded), "current") || strings.Contains(string(encoded), "owner") {
		t.Fatal("internal exact-turn proof leaked to telemetry")
	}
	changed := base
	changed.ActiveTurnID = "different"
	if !sameDesktopProof(base, changed) {
		t.Fatal("history-only active identity changed send readiness proof")
	}
}

func TestHistoryOwnerOverlayRevokesOnDisconnectAndOwnerChangeAndBoundsMap(t *testing.T) {
	d := NewDaemon(&config.Config{NodeID: "node"}, &historyFixture{})
	d.sessionSnapshot = []protocol.Session{{ID: "session"}}
	base := protocol.DesktopObservation{Source: protocol.HistorySourceDesktop, Status: "active", Availability: "available", ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), OwnerID: "owner", ActiveTurnID: "current"}
	updates := make(chan struct{}, 1)
	d.publishDesktop("session", base, updates)
	history := protocol.SessionHistory{Items: []protocol.HistoryItem{{TurnID: "current", TurnStatus: "interrupted"}}, TurnStatuses: make(map[string]string)}
	for i := 0; i < protocol.MaxHistoryTurnStatuses; i++ {
		history.TurnStatuses[fmt.Sprintf("old-%d", i)] = "completed"
	}
	d.overlayDesktopActiveHistory("session", &history)
	if len(history.TurnStatuses) != protocol.MaxHistoryTurnStatuses || history.TurnStatuses["current"] != "inProgress" {
		t.Fatal("owner overlay exceeded map bounds or lost exact active proof")
	}
	d.invalidateDesktop(updates)
	history.Items[0].TurnStatus = "interrupted"
	history.TurnStatuses["current"] = "interrupted"
	d.overlayDesktopActiveHistory("session", &history)
	if history.Items[0].TurnStatus != "interrupted" {
		t.Fatal("disconnected owner retained override authority")
	}
	d.publishDesktop("session", base, updates)
	changed := base
	changed.OwnerID = "new-owner"
	changed.ActiveTurnID = ""
	d.publishDesktop("session", changed, updates)
	d.overlayDesktopActiveHistory("session", &history)
	if history.Items[0].TurnStatus != "interrupted" {
		t.Fatal("owner change retained previous active turn authority")
	}
}
