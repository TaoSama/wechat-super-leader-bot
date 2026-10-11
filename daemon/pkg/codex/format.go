package codex

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

func formatThreadReadOutput(sessionID string, threadObj map[string]any, isLoaded bool) string {
	var b strings.Builder
	title := extractString(threadObj, "title", "name", "preview")
	cwd := extractString(threadObj, "cwd", "path")
	status := extractStatus(threadObj["status"])

	mode := "read-only (not loaded in live app)"
	if isLoaded && status == "idle" {
		mode = "live (read/send)"
	} else if isLoaded {
		mode = fmt.Sprintf("read-only (loaded, %s)", status)
	}

	fmt.Fprintf(&b, "Session: %s\n", sessionID)
	if title != "" {
		fmt.Fprintf(&b, "Title: %s\n", title)
	}
	if cwd != "" {
		fmt.Fprintf(&b, "CWD: %s\n", cwd)
	}
	fmt.Fprintf(&b, "Status: %s | Mode: %s\n", status, mode)

	turns, _ := threadObj["turns"].([]any)
	if len(turns) == 0 {
		b.WriteString("\n(No turns recorded)")
		return b.String()
	}

	startIdx := 0
	if len(turns) > 3 {
		startIdx = len(turns) - 3
	}

	for i := startIdx; i < len(turns); i++ {
		turnMap, ok := turns[i].(map[string]any)
		if !ok {
			continue
		}
		turnID, _ := turnMap["id"].(string)
		turnStatus := extractStatus(turnMap["status"])
		fmt.Fprintf(&b, "\n--- Turn %s (%s) ---\n", turnID, turnStatus)

		items, _ := turnMap["items"].([]any)
		for _, rawItem := range items {
			item, ok := rawItem.(map[string]any)
			if !ok {
				continue
			}
			itemType, _ := item["type"].(string)
			switch itemType {
			case "userMessage":
				userText := extractUserContent(item["content"])
				if userText != "" {
					fmt.Fprintf(&b, "[User]: %s\n", truncateText(userText, MaxReadLineLength))
				}
			case "agentMessage":
				text, _ := item["text"].(string)
				text = strings.TrimSpace(text)
				if text != "" {
					phase, _ := item["phase"].(string)
					if phase != "" {
						fmt.Fprintf(&b, "[Agent/%s]: %s\n", phase, truncateText(text, MaxReadLineLength))
					} else {
						fmt.Fprintf(&b, "[Agent]: %s\n", truncateText(text, MaxReadLineLength))
					}
				}
			}
		}
	}

	return strings.TrimSpace(b.String())
}

func extractUserContent(raw any) string {
	list, ok := raw.([]any)
	if !ok {
		return ""
	}
	var parts []string
	for _, elem := range list {
		if m, ok := elem.(map[string]any); ok {
			if t, ok := m["text"].(string); ok && strings.TrimSpace(t) != "" {
				parts = append(parts, strings.TrimSpace(t))
			}
		}
	}
	return strings.Join(parts, "\n")
}

// truncateText safely truncates a string by rune count to avoid breaking multi-byte UTF-8 sequences.
func truncateText(s string, maxRunes int) string {
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

func extractString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k].(string); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func extractStatus(raw any) string {
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
