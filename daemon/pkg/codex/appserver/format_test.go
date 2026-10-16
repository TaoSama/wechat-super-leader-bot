package appserver

import (
	"strings"
	"testing"
)

func TestReadFormattingDoesNotAdvertiseSendForBusySession(t *testing.T) {
	got := formatThreadReadOutput("test", map[string]any{"status": "active"}, true)
	if strings.Contains(got, "read/send") || !strings.Contains(got, "read-only (loaded, active)") {
		t.Fatalf("unexpected capability description: %q", got)
	}
}
