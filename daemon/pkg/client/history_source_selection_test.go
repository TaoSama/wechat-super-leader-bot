package client

import (
	"context"
	"errors"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type selectedControlHistoryFixture struct {
	historyFixture
	seenCursor string
}

func (f *selectedControlHistoryFixture) ReadHistory(ctx context.Context, id, cursor string, limit int) (protocol.SessionHistory, error) {
	f.seenCursor = cursor
	return f.historyFixture.ReadHistory(ctx, id, cursor, limit)
}

func TestHistoryExplicitControlSourceRequiresNewContextAndKeepsOwner(t *testing.T) {
	raw := "private-control-cursor"
	a := &selectedControlHistoryFixture{historyFixture: historyFixture{history: protocol.SessionHistory{Session: protocol.Session{ID: "session"}, NextCursor: &raw}}}
	f := &routedDesktopFixture{err: errors.New(protocol.HistoryTooLarge)}
	d := NewDaemon(&config.Config{NodeID: "node"}, a)
	d.desktopHistory = f
	d.desktopSnapshot["session"] = protocol.DesktopObservation{OwnerID: "owner"}
	msg := routedHistoryRequest()
	if got := d.ReadHistory(context.Background(), msg); got.Error != protocol.HistoryTooLarge || a.called.Load() != 0 {
		t.Fatal("default desktop failure silently fell back")
	}
	if len(d.historyContexts.bindings) != 0 {
		t.Fatal("failed initial context leaked")
	}
	msg.Source = protocol.HistorySourceControl
	first := requireHistory(t, d, msg)
	if first.Source != protocol.HistorySourceControl || first.HistoryContext == "" || first.NextCursor == nil || *first.NextCursor == raw || f.calls != 1 || a.called.Load() != 1 {
		t.Fatal("explicit control page did not create its own opaque binding")
	}
	msg.HistoryContext, msg.Cursor = first.HistoryContext, *first.NextCursor
	older := requireHistory(t, d, msg)
	if older.HistoryContext != first.HistoryContext || older.Source != first.Source || a.seenCursor != raw {
		t.Fatal("explicit source lost its older-page binding")
	}
	msg.Source, msg.Cursor = "", ""
	latest := requireHistory(t, d, msg)
	if latest.HistoryContext != first.HistoryContext || latest.Source != first.Source || f.calls != 1 {
		t.Fatal("omitting selection changed a pinned source")
	}
	if d.desktopSnapshot["session"].OwnerID != "owner" || len(d.outbox) != 0 || len(d.dedupeCache) != 0 || len(d.inFlight) != 0 || len(d.sessionLocks) != 0 {
		t.Fatal("history selection changed control owner or command bookkeeping")
	}
}

func TestHistoryExplicitSourceMismatchRejectsBeforeEitherReader(t *testing.T) {
	raw := "private-desktop-cursor"
	a := &historyFixture{history: protocol.SessionHistory{Session: protocol.Session{ID: "session"}}}
	f := &routedDesktopFixture{history: protocol.SessionHistory{Session: protocol.Session{ID: "session"}, NextCursor: &raw}, generation: "desktop-generation"}
	d := NewDaemon(&config.Config{NodeID: "node"}, a)
	d.desktopHistory, d.desktopSnapshot["session"] = f, protocol.DesktopObservation{OwnerID: "owner"}
	msg := routedHistoryRequest()
	first := requireHistory(t, d, msg)
	msg.Source, msg.HistoryContext = protocol.HistorySourceControl, first.HistoryContext
	for _, cursor := range []string{"", *first.NextCursor} {
		msg.Cursor = cursor
		if got := d.ReadHistory(context.Background(), msg); got.Error != protocol.HistoryContextExpired || got.History != nil {
			t.Fatal("source mismatch was ignored or mixed pages")
		}
	}
	if f.calls != 1 || a.called.Load() != 0 {
		t.Fatal("source mismatch reached a backend")
	}
	msg.Source, msg.Cursor = "", ""
	if got := requireHistory(t, d, msg); got.Source != first.Source || got.HistoryContext != first.HistoryContext {
		t.Fatal("rejected selection revoked an otherwise valid context")
	}
}

func TestHistoryExplicitControlFailureNeverReturnsDesktopOrTerminalHistory(t *testing.T) {
	a := &historyFixture{err: errors.New(protocol.HistoryUnavailable)}
	f := &routedDesktopFixture{history: protocol.SessionHistory{Session: protocol.Session{ID: "session"}}, generation: "generation"}
	d := NewDaemon(&config.Config{NodeID: "node"}, a)
	d.desktopHistory, d.desktopSnapshot["session"] = f, protocol.DesktopObservation{OwnerID: "owner"}
	msg := routedHistoryRequest()
	msg.Source = protocol.HistorySourceControl
	if got := d.ReadHistory(context.Background(), msg); got.Error != protocol.HistoryUnavailable || f.calls != 0 || a.called.Load() != 1 {
		t.Fatal("explicit control failure fell back to desktop")
	}
	msg.SessionID = "terminal:fixture"
	if got := d.ReadHistory(context.Background(), msg); got.Error != protocol.HistoryUnavailable || a.called.Load() != 1 {
		t.Fatal("terminal identity reached the native control adapter")
	}
	msg.SessionID, msg.Source = "session", protocol.HistorySourceDesktop
	if got := d.ReadHistory(context.Background(), msg); got.Error != protocol.HistoryInvalidRequest || f.calls != 0 || a.called.Load() != 1 {
		t.Fatal("unsupported explicit source reached a backend")
	}
	if len(d.historyContexts.bindings) != 0 {
		t.Fatal("failed selection retained a new context")
	}
}
