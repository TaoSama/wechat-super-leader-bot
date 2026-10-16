package threadstate

import (
	"strings"
	"unicode/utf8"
)

// TruncateText safely truncates a string by rune count to avoid breaking multi-byte UTF-8 sequences.
func TruncateText(s string, maxRunes int) string {
	if maxRunes <= 0 {
		return ""
	}
	if utf8.RuneCountInString(s) <= maxRunes {
		return s
	}

	runes := []rune(s)
	if len(runes) > maxRunes {
		return string(runes[:maxRunes]) + "...(truncated)"
	}
	return s
}

func ExtractString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k].(string); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func ExtractStatus(raw any) string {
	switch v := raw.(type) {
	case string:
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	case map[string]any:
		if t, ok := v["type"].(string); ok && strings.TrimSpace(t) != "" {
			return strings.TrimSpace(t)
		}
	}
	return "unknown"
}
