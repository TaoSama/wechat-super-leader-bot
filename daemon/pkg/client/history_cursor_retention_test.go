package client

import (
	"context"
	"fmt"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestHistoryCursorTailRefreshRemainsAvailableAfterEviction(t *testing.T) {
	a := &selectedControlHistoryFixture{historyFixture: historyFixture{
		history: protocol.SessionHistory{Session: protocol.Session{ID: "session"}},
	}}
	d := NewDaemon(&config.Config{NodeID: "node"}, a)
	msg := routedHistoryRequest()
	var firstToken, recentToken, recentRaw string
	for i := 0; i < 3*maxHistoryContextCursors; i++ {
		recentRaw = fmt.Sprintf("tail-boundary-%d", i)
		a.history.NextCursor = &recentRaw
		page := requireHistory(t, d, msg)
		if page.NextCursor == nil {
			t.Fatal("tail lost its pagination boundary")
		}
		if i == 0 {
			msg.HistoryContext, firstToken = page.HistoryContext, *page.NextCursor
		}
		if page.HistoryContext != msg.HistoryContext {
			t.Fatal("tail refresh unexpectedly replaced its context")
		}
		recentToken = *page.NextCursor
		binding := d.historyContexts.bindings[msg.HistoryContext]
		if len(binding.cursors) > maxHistoryContextCursors || len(binding.cursorTokens) > maxHistoryContextCursors || len(binding.cursorOrder) > maxHistoryContextCursors {
			t.Fatal("tail refresh exceeded cursor retention limit")
		}
	}

	msg.Cursor = firstToken
	calls := a.called.Load()
	if got := d.ReadHistory(context.Background(), msg); got.Error != protocol.HistoryContextExpired || got.History != nil || a.called.Load() != calls {
		t.Fatalf("evicted cursor was not rejected before reading: %+v", got)
	}
	msg.Cursor = recentToken
	requireHistory(t, d, msg)
	if a.seenCursor != recentRaw {
		t.Fatalf("retained cursor read wrong boundary: %q", a.seenCursor)
	}
	msg.Cursor = ""
	requireHistory(t, d, msg)

	// Recovery creates a fresh binding, even when the backend boundary matches.
	previousContext := msg.HistoryContext
	msg.HistoryContext = ""
	recovered := requireHistory(t, d, msg)
	if recovered.HistoryContext == "" || recovered.HistoryContext == previousContext || recovered.NextCursor == nil || *recovered.NextCursor == recentToken {
		t.Fatal("recovery failed to issue a fresh history context and cursor")
	}
	msg.HistoryContext, msg.Cursor = recovered.HistoryContext, recentToken
	calls = a.called.Load()
	if got := d.ReadHistory(context.Background(), msg); got.Error != protocol.HistoryContextExpired || a.called.Load() != calls {
		t.Fatalf("cursor crossed recovery context: %+v", got)
	}
	msg.Cursor = *recovered.NextCursor
	requireHistory(t, d, msg)
}

func TestHistoryCursorRetentionTouchesConsumedAndReissuedBoundaries(t *testing.T) {
	a := &selectedControlHistoryFixture{historyFixture: historyFixture{
		history: protocol.SessionHistory{Session: protocol.Session{ID: "session"}},
	}}
	d := NewDaemon(&config.Config{NodeID: "node"}, a)
	msg := routedHistoryRequest()
	var firstToken, secondToken string
	for i := 0; i < maxHistoryContextCursors; i++ {
		raw := fmt.Sprintf("boundary-%d", i)
		a.history.NextCursor = &raw
		page := requireHistory(t, d, msg)
		msg.HistoryContext = page.HistoryContext
		if i == 0 {
			firstToken = *page.NextCursor
		} else if i == 1 {
			secondToken = *page.NextCursor
		}
	}
	msg.Cursor = firstToken
	requireHistory(t, d, msg)
	if a.seenCursor != "boundary-0" {
		t.Fatal("older-page token did not resolve its original boundary")
	}
	msg.Cursor = ""
	raw := "new-tail-boundary"
	a.history.NextCursor = &raw
	requireHistory(t, d, msg)
	binding := d.historyContexts.bindings[msg.HistoryContext]
	if _, retained := binding.cursors[firstToken]; !retained {
		t.Fatal("recently consumed older-page cursor was evicted")
	}
	if _, retained := binding.cursors[secondToken]; retained {
		t.Fatal("least recently used cursor was retained")
	}

	// Reissuing an existing backend boundary also keeps its original token live.
	raw = "boundary-2"
	a.history.NextCursor = &raw
	retained := requireHistory(t, d, msg)
	raw = "another-tail-boundary"
	a.history.NextCursor = &raw
	requireHistory(t, d, msg)
	if binding.cursors[*retained.NextCursor] != "boundary-2" {
		t.Fatal("recently reissued cursor was evicted")
	}
}
