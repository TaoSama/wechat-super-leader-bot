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

// Session status strings derived from an active thread's native activeFlags.
const (
	StatusWaitingApproval  = "waitingApproval"
	StatusWaitingUserInput = "waitingUserInput"
	nativeStatusActive     = "active"
	flagWaitingOnApproval  = "waitingOnApproval"
	flagWaitingOnUserInput = "waitingOnUserInput"
)

// ExtractStatus returns a status string. A native thread status object
// {type:"active", activeFlags:[...]} maps a pending approval or user-input
// flag to waitingApproval / waitingUserInput; approval wins when both are set.
func ExtractStatus(raw any) string {
	switch v := raw.(type) {
	case string:
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	case map[string]any:
		t, ok := v["type"].(string)
		if !ok || strings.TrimSpace(t) == "" {
			break
		}
		t = strings.TrimSpace(t)
		if t == nativeStatusActive {
			if flagged := activeFlagStatus(v["activeFlags"]); flagged != "" {
				return flagged
			}
		}
		return t
	}
	return "unknown"
}

func activeFlagStatus(raw any) string {
	flags, _ := raw.([]any)
	waitingInput := false
	for _, flag := range flags {
		switch flag {
		case flagWaitingOnApproval:
			return StatusWaitingApproval
		case flagWaitingOnUserInput:
			waitingInput = true
		}
	}
	if waitingInput {
		return StatusWaitingUserInput
	}
	return ""
}
