package live_test

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/desktop"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestLiveCodexDesktopReadonlySnapshot(t *testing.T) {
	path, id := os.Getenv("LIVE_CODEX_DESKTOP_SOCKET"), os.Getenv("LIVE_CODEX_DESKTOP_SESSION")
	if path == "" || id == "" {
		t.Skip("requires explicit LIVE_CODEX_DESKTOP_SOCKET and LIVE_CODEX_DESKTOP_SESSION")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var observations []protocol.DesktopObservation
	err := desktop.NewDesktopObserver(path).Snapshot(ctx, []string{id}, func(observedID string, observation protocol.DesktopObservation) {
		if observedID != id {
			t.Errorf("wrong live session %q", observedID)
		}
		observations = append(observations, observation)
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(observations) != 1 || observations[0].Source != "codex-desktop" || observations[0].Availability != "available" {
		t.Fatalf("live observations = %+v", observations)
	}
	if observations[0].Status != "active" && observations[0].Status != "idle" && observations[0].Status != "unknown" {
		t.Fatalf("unexpected live status %q", observations[0].Status)
	}
	t.Logf("readonly snapshot: status=%s observedAt=%s", observations[0].Status, observations[0].ObservedAt)
}
