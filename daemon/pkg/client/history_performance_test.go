package client

import (
	"context"
	"errors"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type pagedHistoryFixture struct{ historyFixture }

func (*pagedHistoryFixture) PagedHistoryAvailable() bool { return true }

func TestPagedHistoryReturnsTailBeforeDesktopHydration(t *testing.T) {
	raw := "native-older"
	adapter := &pagedHistoryFixture{historyFixture: historyFixture{history: protocol.SessionHistory{
		Session: protocol.Session{ID: "session"}, Items: []protocol.HistoryItem{{ID: "tail", Text: "latest"}}, NextCursor: &raw,
	}}}
	desktop := &routedDesktopFixture{err: errors.New(protocol.HistoryTimeout)}
	daemon := NewDaemon(&config.Config{NodeID: "node"}, adapter)
	daemon.desktopHistory = desktop
	daemon.desktopSnapshot["session"] = protocol.DesktopObservation{OwnerID: "known-owner"}
	request := routedHistoryRequest()
	first := requireHistory(t, daemon, request)
	if first.Source != protocol.HistorySourceControl || desktop.calls != 0 || adapter.called.Load() != 1 || first.NextCursor == nil || *first.NextCursor == raw {
		t.Fatalf("tail waited for full desktop state: %+v", first)
	}
	adapter.err = errors.New(protocol.HistoryUnavailable)
	request.HistoryContext = first.HistoryContext
	if got := daemon.ReadHistory(context.Background(), request); got.Error != protocol.HistoryUnavailable || desktop.calls != 0 {
		t.Fatal("a pinned native context switched to desktop after an error")
	}
}

func TestUnavailableNativePaginationFallsBackOnlyBeforeFirstPage(t *testing.T) {
	adapter := &pagedHistoryFixture{historyFixture: historyFixture{err: errors.New(protocol.HistoryUnavailable)}}
	raw := "desktop-older"
	desktop := &routedDesktopFixture{history: protocol.SessionHistory{Session: protocol.Session{ID: "session"}, NextCursor: &raw}, generation: "desktop-generation"}
	daemon := NewDaemon(&config.Config{NodeID: "node"}, adapter)
	daemon.desktopHistory = desktop
	daemon.desktopSnapshot["session"] = protocol.DesktopObservation{OwnerID: "known-owner"}
	request := routedHistoryRequest()
	first := requireHistory(t, daemon, request)
	if first.Source != protocol.HistorySourceDesktop || desktop.calls != 1 || adapter.called.Load() != 1 {
		t.Fatal("missing initial compatibility fallback")
	}
	request.HistoryContext, request.Cursor = first.HistoryContext, *first.NextCursor
	older := requireHistory(t, daemon, request)
	if older.HistoryContext != first.HistoryContext || desktop.seenCursor != raw || adapter.called.Load() != 1 {
		t.Fatal("fallback context lost desktop cursor/source")
	}
	request.HistoryContext, request.Cursor, request.Source = "", "", protocol.HistorySourceControl
	if got := daemon.ReadHistory(context.Background(), request); got.Error != protocol.HistoryUnavailable || desktop.calls != 2 {
		t.Fatal("explicit native source silently fell back")
	}
}

func TestInvalidNativeHistoryDoesNotFallbackToDesktop(t *testing.T) {
	adapter := &pagedHistoryFixture{historyFixture: historyFixture{err: errors.New(protocol.HistoryFailed)}}
	desktop := &routedDesktopFixture{}
	daemon := NewDaemon(&config.Config{NodeID: "node"}, adapter)
	daemon.desktopHistory = desktop
	daemon.desktopSnapshot["session"] = protocol.DesktopObservation{OwnerID: "known-owner"}
	if got := daemon.ReadHistory(context.Background(), routedHistoryRequest()); got.Error != protocol.HistoryFailed || desktop.calls != 0 {
		t.Fatal("malformed native data was hidden by fallback")
	}
}
