package desktop

import (
	"context"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestDesktopHistoryIdleCacheDoesNotLimitSequentialSessionBrowsing(t *testing.T) {
	path := desktopFixture(t, func(c *desktopConn) error {
		if err := historyFixtureStart(c, historyTestState(false)); err != nil {
			return err
		}
		return historyFixtureEnd(c)
	})
	reader := NewDesktopHistoryReader(path)
	t.Cleanup(reader.Reset)
	var evicted *desktopHistoryEntry
	for i, id := range []string{"oldest", "active", "recent", "newest"} {
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		close(done)
		entry := &desktopHistoryEntry{sessionID: id, ctx: ctx, cancel: cancel, done: done, generation: "generation",
			lastUsed: time.Now().Add(time.Duration(i-4) * time.Second)}
		if id == "active" {
			entry.active = 1
			entry.lastUsed = time.Now().Add(-time.Minute / 2)
		}
		reader.entries[id] = entry
		if i == 0 {
			evicted = entry
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
	defer cancel()
	if _, _, err := reader.ReadHistory(ctx, "session", "", "", 1); err != nil {
		t.Fatalf("fifth sequential target could not load: %v", err)
	}
	if len(reader.entries) != desktopHistoryTargetLimit || reader.entries["oldest"] != nil || reader.entries["active"] == nil || evicted.ctx.Err() == nil {
		t.Fatal("cache did not evict only the least recently used idle subscription")
	}
	if _, _, err := reader.ReadHistory(ctx, "oldest", "generation", "", 1); err == nil || err.Error() != protocol.HistoryContextExpired {
		t.Fatal("evicted generation was silently recreated")
	}
}

func TestDesktopHistoryTailCarriesKnownCompletedStatusForOlderReadingWindow(t *testing.T) {
	entry := &desktopHistoryEntry{generation: "generation", cursors: map[string]desktopHistoryAnchor{}, anchorTokens: map[desktopHistoryAnchor]string{}, view: desktopHistoryView{
		session: protocol.Session{ID: "session"}, items: []protocol.HistoryItem{
			{ID: "old", TurnID: "older-turn", TurnStatus: "completed", Kind: "assistant", Type: "agentMessage", Text: "old output"},
			{ID: "new", TurnID: "latest-turn", TurnStatus: "inProgress", Kind: "assistant", Type: "agentMessage", Text: "new output"},
		}}}
	page, err := entry.pageLocked("", 1)
	if err != nil || len(page.Items) != 1 || page.Items[0].ID != "new" || page.TurnStatuses["older-turn"] != "completed" || page.TurnStatuses["latest-turn"] != "inProgress" {
		t.Fatalf("tail omitted exact known states for older rows: %v", err)
	}
}
