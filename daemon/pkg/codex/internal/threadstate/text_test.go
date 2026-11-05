package threadstate

import (
	"testing"
	"unicode/utf8"
)

func TestTruncateTextPreservesUnicode(t *testing.T) {
	got := TruncateText("中文🙂测试", 3)
	if !utf8.ValidString(got) || got != "中文🙂...(truncated)" {
		t.Fatalf("unexpected truncated output: %q", got)
	}
}

func TestExtractStatusMapsActiveFlags(t *testing.T) {
	for _, tc := range []struct {
		raw  any
		want string
	}{
		{"idle", "idle"},
		{map[string]any{"type": "idle"}, "idle"},
		{map[string]any{"type": "active", "activeFlags": []any{}}, "active"},
		{map[string]any{"type": "active"}, "active"},
		{map[string]any{"type": "active", "activeFlags": []any{"waitingOnApproval"}}, StatusWaitingApproval},
		{map[string]any{"type": "active", "activeFlags": []any{"waitingOnUserInput"}}, StatusWaitingUserInput},
		{map[string]any{"type": "active", "activeFlags": []any{"waitingOnUserInput", "waitingOnApproval"}}, StatusWaitingApproval},
		{map[string]any{"type": "active", "activeFlags": []any{"future"}}, "active"},
		{map[string]any{"type": "idle", "activeFlags": []any{"waitingOnApproval"}}, "idle"},
		{map[string]any{}, "unknown"},
		{nil, "unknown"},
	} {
		if got := ExtractStatus(tc.raw); got != tc.want {
			t.Fatalf("ExtractStatus(%v) = %q, want %q", tc.raw, got, tc.want)
		}
	}
}
