//go:build darwin || linux

package codex

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

// This opt-in diagnostic reads metadata only, without RPC, Controller or journal.
func TestLiveRolloutCatalog(t *testing.T) {
	home := os.Getenv("LIVE_CODEX_CATALOG_HOME")
	if home == "" {
		t.Skip("set LIVE_CODEX_CATALOG_HOME to explicitly enable metadata-only discovery")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	sessions, err := NewRolloutCatalog(home).DiscoverSessions(ctx)
	if err != nil {
		t.Fatalf("metadata-only discovery: %v", err)
	}
	for _, session := range sessions {
		if session.Status != "unknown" || session.Loaded == nil || *session.Loaded || len(session.Capabilities) != 1 || session.Capabilities[0] != protocol.ActionRead {
			t.Fatal("file discovery granted live authority")
		}
	}
	t.Logf("verified metadata-only sessions: %d", len(sessions))
}
