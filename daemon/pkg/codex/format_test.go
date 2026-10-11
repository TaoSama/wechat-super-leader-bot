package codex

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestTruncateTextPreservesUnicode(t *testing.T) {
	got := truncateText("中文🙂测试", 3)
	if !utf8.ValidString(got) || got != "中文🙂...(truncated)" {
		t.Fatalf("unexpected truncated output: %q", got)
	}
}

func TestReadFormattingDoesNotAdvertiseSendForBusySession(t *testing.T) {
	got := formatThreadReadOutput("test", map[string]any{"status": "active"}, true)
	if strings.Contains(got, "read/send") || !strings.Contains(got, "read-only (loaded, active)") {
		t.Fatalf("unexpected capability description: %q", got)
	}
}
