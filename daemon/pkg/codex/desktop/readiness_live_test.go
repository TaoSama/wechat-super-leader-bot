package desktop

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

// Select an explicitly known active owner. This only exercises preflight;
// no dispatch identity, journal, turn start or resume is created.
func TestLiveCodexDesktopReadonlyReadiness(t *testing.T) {
	path, sessionID := os.Getenv("LIVE_CODEX_DESKTOP_SOCKET"), os.Getenv("LIVE_CODEX_DESKTOP_SESSION")
	if path == "" || sessionID == "" || os.Getenv("LIVE_CODEX_DESKTOP_READINESS") != "1" {
		t.Skip("requires explicit socket, active session and LIVE_CODEX_DESKTOP_READINESS=1")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	err := NewDesktopController(path).CheckSendReadiness(ctx, sessionID)
	if !errors.Is(err, ErrDesktopSendBusy) {
		t.Logf("readonly preflight classification: structuralLimit=%t invalidState=%t canceled=%t deadline=%t frameLimit=%t unexpectedSuccess=%t", errors.Is(err, errDesktopControlStateLimit), errors.Is(err, errDesktopControlStateJSON), errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded), errors.Is(err, errDesktopFrameTooLarge), err == nil)
		t.Fatal("readonly preflight did not reach the expected busy rejection")
	}
	t.Log("readonly original-owner preflight: large snapshot parsed; active target remains rejected; no dispatch")
}
