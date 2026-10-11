package codex

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

// Explicit opt-in for an existing owner only. This never resumes or sends a
// turn and never logs message bodies. Full loading may populate the owner's cache.
func TestLiveCodexDesktopReadonlyHistory(t *testing.T) {
	path, sessionID := os.Getenv("LIVE_CODEX_DESKTOP_SOCKET"), os.Getenv("LIVE_CODEX_DESKTOP_SESSION")
	if path == "" || sessionID == "" || os.Getenv("LIVE_CODEX_DESKTOP_HISTORY") != "1" {
		t.Skip("requires explicit socket, session and LIVE_CODEX_DESKTOP_HISTORY=1")
	}
	reader := NewDesktopHistoryReader(path)
	defer reader.Reset()
	read := func(generation, cursor string) (protocol.SessionHistory, string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		history, nextGeneration, err := reader.ReadHistory(ctx, sessionID, generation, cursor, 3)
		if err != nil {
			t.Fatalf("readonly history: %v", err)
		}
		if history.Session.ID != sessionID || history.Source != protocol.HistorySourceDesktop || nextGeneration == "" || len(history.Items) > 3 {
			t.Fatal("readonly history target/source/page identity invalid")
		}
		return history, nextGeneration
	}
	first, generation := read("", "")
	seen := map[string]bool{}
	for _, item := range first.Items {
		if seen[item.ID] {
			t.Fatal("duplicate latest item")
		}
		seen[item.ID] = true
	}
	olderCount := 0
	if first.NextCursor != nil {
		older, olderGeneration := read(generation, *first.NextCursor)
		if olderGeneration != generation {
			t.Fatal("older page changed generation")
		}
		for _, item := range older.Items {
			if seen[item.ID] {
				t.Fatal("older page overlaps latest")
			}
			seen[item.ID] = true
		}
		olderCount = len(older.Items)
	}
	latest, latestGeneration := read(generation, "")
	if latestGeneration != generation {
		t.Fatal("latest page changed generation")
	}
	t.Logf("readonly existing owner history: first=%d older=%d latest=%d source=%s; stable generation; no message bodies logged", len(first.Items), olderCount, len(latest.Items), latest.Source)
}
