package client

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type routedDesktopFixture struct {
	history                                protocol.SessionHistory
	generation, seenGeneration, seenCursor string
	err                                    error
	calls, resets                          int
}

func (f *routedDesktopFixture) ReadHistory(_ context.Context, _, generation, cursor string, _ int) (protocol.SessionHistory, string, error) {
	f.calls++
	f.seenGeneration, f.seenCursor = generation, cursor
	return f.history, f.generation, f.err
}
func (f *routedDesktopFixture) Reset() { f.resets++ }

func routedHistoryRequest() protocol.ReadHistoryMessage {
	return protocol.ReadHistoryMessage{Type: "read_history", RequestID: "request", NodeID: "node", SessionID: "session"}
}

func requireHistory(t *testing.T, d *Daemon, msg protocol.ReadHistoryMessage) protocol.SessionHistory {
	t.Helper()
	res := d.ReadHistory(context.Background(), msg)
	if res.Error != "" || res.History == nil {
		t.Fatalf("history failed: %+v", res)
	}
	return *res.History
}

func TestHistoryContextPinsSourceAcrossLatestAndOlderRequests(t *testing.T) {
	raw := "private-backend-cursor"
	a := &historyFixture{history: protocol.SessionHistory{Session: protocol.Session{ID: "session"}, NextCursor: &raw}}
	f := &routedDesktopFixture{history: a.history, generation: "generation-one"}
	d := NewDaemon(&config.Config{NodeID: "node"}, a)
	d.desktopHistory = f
	msg := routedHistoryRequest()
	first := requireHistory(t, d, msg)
	if first.Source != protocol.HistorySourceControl || first.HistoryContext == "" || *first.NextCursor == raw {
		t.Fatalf("unbound first page: %+v", first)
	}
	d.desktopSnapshot["session"] = protocol.DesktopObservation{OwnerID: "owner"}
	msg.HistoryContext = first.HistoryContext
	latest := requireHistory(t, d, msg)
	if latest.HistoryContext != first.HistoryContext || latest.Source != first.Source || *latest.NextCursor != *first.NextCursor || f.calls != 0 {
		t.Fatal("latest snapshot silently changed source/cursor")
	}
	msg.HistoryContext = ""
	desktop := requireHistory(t, d, msg)
	if desktop.Source != protocol.HistorySourceDesktop || desktop.HistoryContext == first.HistoryContext {
		t.Fatal("explicit new context did not choose desktop")
	}
	delete(d.desktopSnapshot, "session")
	msg.HistoryContext, msg.Cursor = desktop.HistoryContext, *desktop.NextCursor
	older := requireHistory(t, d, msg)
	if older.Source != protocol.HistorySourceDesktop || f.seenGeneration != "generation-one" || f.seenCursor != raw {
		t.Fatal("older page lost binding")
	}
	f.err = errors.New(protocol.HistoryUnavailable)
	if got := d.ReadHistory(context.Background(), msg); got.Error != protocol.HistoryUnavailable || a.called.Load() != 2 {
		t.Fatal("desktop error fell back to native")
	}
}

func TestHistoryContextRejectsCrossTargetCursorAndGeneration(t *testing.T) {
	raw := "native-cursor"
	a := &historyFixture{history: protocol.SessionHistory{Session: protocol.Session{ID: "session"}, NextCursor: &raw}}
	f := &routedDesktopFixture{history: a.history, generation: "generation-one"}
	d := NewDaemon(&config.Config{NodeID: "node"}, a)
	d.desktopHistory, d.desktopSnapshot["session"] = f, protocol.DesktopObservation{OwnerID: "owner"}
	msg := routedHistoryRequest()
	first, second := requireHistory(t, d, msg), requireHistory(t, d, msg)
	for _, tc := range []struct{ name, session, token, cursor string }{
		{"wrong-target", "other", first.HistoryContext, ""},
		{"unknown-context", "session", "missing", ""},
		{"raw-cursor", "session", first.HistoryContext, raw},
		{"cross-context-cursor", "session", second.HistoryContext, *first.NextCursor},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bad := msg
			bad.SessionID, bad.HistoryContext, bad.Cursor = tc.session, tc.token, tc.cursor
			if got := d.ReadHistory(context.Background(), bad); got.Error != protocol.HistoryContextExpired {
				t.Fatalf("accepted invalid binding: %+v", got)
			}
		})
	}
	if f.calls != 2 {
		t.Fatal("invalid binding reached reader")
	}
	msg.HistoryContext = first.HistoryContext
	f.generation = "generation-two"
	if got := d.ReadHistory(context.Background(), msg); got.Error != protocol.HistoryContextExpired {
		t.Fatal("accepted changed generation")
	}
	d.resetHistory()
	if got := d.ReadHistory(context.Background(), msg); got.Error != protocol.HistoryContextExpired || f.resets != 1 {
		t.Fatal("reset retained old binding")
	}
}

func TestDesktopHistoryChecksReaderIdentityBeforeMetadataMerge(t *testing.T) {
	a := &historyFixture{}
	f := &routedDesktopFixture{history: protocol.SessionHistory{Session: protocol.Session{ID: "other"}}, generation: "generation"}
	d := NewDaemon(&config.Config{NodeID: "node"}, a)
	d.desktopHistory, d.desktopSnapshot["session"] = f, protocol.DesktopObservation{OwnerID: "owner"}
	d.sessionSnapshot = []protocol.Session{{ID: "session", Status: "notLoaded"}}
	if got := d.ReadHistory(context.Background(), routedHistoryRequest()); got.Error != protocol.HistoryFailed {
		t.Fatal("cached metadata concealed wrong reader target")
	}
	if len(d.historyContexts.bindings) != 0 {
		t.Fatal("failed initial context leaked")
	}
	f.history.Session.ID = "session"
	got := requireHistory(t, d, routedHistoryRequest())
	if got.Session.Status != "notLoaded" {
		t.Fatal("desktop history synthesized native facts")
	}
}

func TestDesktopHistoryPreservesStaticTimeout(t *testing.T) {
	d := NewDaemon(&config.Config{NodeID: "node"}, &historyFixture{})
	d.desktopHistory = &routedDesktopFixture{err: errors.New(protocol.HistoryTimeout)}
	d.desktopSnapshot["session"] = protocol.DesktopObservation{OwnerID: "owner"}
	if got := d.ReadHistory(context.Background(), routedHistoryRequest()); got.Error != protocol.HistoryTimeout || got.History != nil {
		t.Fatal("desktop operation timeout was reduced to generic failure")
	}
}

func TestHistoryRegistryBoundsExpiryAndCancelableGate(t *testing.T) {
	h := newHistoryContexts()
	msg := routedHistoryRequest()
	first, _, err := h.acquire(context.Background(), msg, protocol.HistorySourceControl)
	if err != nil {
		t.Fatal(err)
	}
	msg.HistoryContext = first.token
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := h.acquire(ctx, msg, protocol.HistorySourceDesktop); !errors.Is(err, context.Canceled) {
		t.Fatalf("gate did not cancel: %v", err)
	}
	<-first.gate
	msg.NodeID = "other"
	if _, _, err := h.acquire(context.Background(), msg, protocol.HistorySourceControl); err == nil || err.Error() != protocol.HistoryContextExpired {
		t.Fatal("node binding not enforced")
	}
	msg.NodeID = "node"
	first.expiresAt = time.Now().Add(-time.Second)
	if _, _, err := h.acquire(context.Background(), msg, protocol.HistorySourceControl); err == nil || err.Error() != protocol.HistoryContextExpired {
		t.Fatal("expired context accepted")
	}
	msg.HistoryContext = ""
	for i := 0; i < maxHistoryContexts; i++ {
		binding, _, err := h.acquire(context.Background(), msg, protocol.HistorySourceControl)
		if err != nil {
			t.Fatal(err)
		}
		<-binding.gate
	}
	if _, _, err := h.acquire(context.Background(), msg, protocol.HistorySourceControl); err == nil || err.Error() != protocol.HistoryBusy {
		t.Fatal("registry capacity not enforced")
	}
	h.reset()
	if h.current(first) {
		t.Fatal("reset did not revoke context")
	}
}

func TestHistoryCursorTokensAreStableAndBounded(t *testing.T) {
	b := &historyBinding{cursors: map[string]string{}, cursorTokens: map[string]string{}}
	for i := 0; i < maxHistoryContextCursors; i++ {
		raw := fmt.Sprintf("raw-%d", i)
		one, err := b.wrapCursor(&raw)
		if err != nil {
			t.Fatal(err)
		}
		two, err := b.wrapCursor(&raw)
		if err != nil || *one != *two || *one == raw || b.cursors[*one] != raw {
			t.Fatal("cursor token not stable/opaque")
		}
	}
	raw := "one-too-many"
	if _, err := b.wrapCursor(&raw); err == nil || err.Error() != protocol.HistoryBusy {
		t.Fatal("cursor registry unbounded")
	}
	if got, err := b.wrapCursor(nil); got != nil || err != nil {
		t.Fatal("nil cursor changed")
	}
	raw = ""
	if _, err := b.wrapCursor(&raw); err == nil {
		t.Fatal("empty backend cursor accepted")
	}
}

func TestHistorySourceRequiresConfirmedDesktopOwner(t *testing.T) {
	a := &historyFixture{history: protocol.SessionHistory{Session: protocol.Session{ID: "session"}}}
	f := &routedDesktopFixture{history: a.history, generation: "generation-one"}
	d := NewDaemon(&config.Config{NodeID: "node"}, a)
	d.desktopHistory = f
	d.sessionSnapshot = []protocol.Session{{ID: "session"}}
	updates := make(chan struct{}, 1)
	placeholder := protocol.DesktopObservation{Source: "codex-desktop", Availability: "unavailable", Status: "unknown"}
	d.publishDesktop("session", placeholder, updates)
	if got := requireHistory(t, d, routedHistoryRequest()); got.Source != protocol.HistorySourceControl || f.calls != 0 {
		t.Fatal("ownerless discovery placeholder hijacked native history")
	}
	d.publishDesktop("session", protocol.DesktopObservation{Source: "codex-desktop", OwnerID: "known-owner", Availability: "available"}, updates)
	d.publishDesktop("session", placeholder, updates)
	if got := requireHistory(t, d, routedHistoryRequest()); got.Source != protocol.HistorySourceDesktop || f.calls != 1 {
		t.Fatal("known unavailable desktop owner silently fell back")
	}
}
