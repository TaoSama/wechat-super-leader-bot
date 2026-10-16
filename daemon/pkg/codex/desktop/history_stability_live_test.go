package desktop

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	desktopHistoryStabilityDuration = 75 * time.Second
	desktopHistoryStabilityPoll     = 2 * time.Second
	desktopHistoryStabilityRead     = 8 * time.Second
)

// Explicit existing target only: reuse one production reader generation longer
// than its idle TTL while polling. No bodies, identities or raw errors are logged.
func TestLiveCodexDesktopReadonlyHistoryStability(t *testing.T) {
	path, target := os.Getenv("LIVE_CODEX_DESKTOP_SOCKET"), os.Getenv("LIVE_CODEX_DESKTOP_SESSION")
	if os.Getenv("LIVE_CODEX_DESKTOP_HISTORY_STABILITY") != "1" || path == "" || target == "" {
		t.Skip("requires explicit socket, target and LIVE_CODEX_DESKTOP_HISTORY_STABILITY=1")
	}
	if !protocol.ValidHistoryIdentity(target) || !protocol.ValidTurnID(target) {
		t.Fatal("invalid target; no connection attempted")
	}
	reader := NewDesktopHistoryReader(path)
	defer reader.Reset()
	ctx, cancel := context.WithTimeout(context.Background(), desktopHistoryStabilityDuration)
	defer cancel()
	ticker := time.NewTicker(desktopHistoryStabilityPoll)
	defer ticker.Stop()
	generation, samples := "", 0
	for {
		readCtx, readCancel := context.WithTimeout(ctx, desktopHistoryStabilityRead)
		page, current, err := reader.ReadHistory(readCtx, target, generation, "", 1)
		readCancel()
		if ctx.Err() != nil && samples > 0 {
			t.Logf("continuous_context=true samples=%d; no bodies or identities logged", samples)
			return
		}
		if err != nil {
			t.Fatalf("continuous_context=false samples=%d error=%s", samples, historyDiagnosticError(err))
		}
		if current == "" || generation != "" && current != generation || page.Source != protocol.HistorySourceDesktop {
			t.Fatal("reader changed generation or source")
		}
		generation = current
		samples++
		if samples == 1 || samples%10 == 0 {
			t.Logf("continuous_context=true samples=%d page_items=%d", samples, len(page.Items))
		}
		select {
		case <-ctx.Done():
			t.Logf("continuous_context=true samples=%d; no bodies or identities logged", samples)
			return
		case <-ticker.C:
		}
	}
}
