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
