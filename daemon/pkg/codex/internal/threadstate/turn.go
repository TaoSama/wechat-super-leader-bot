package threadstate

import (
	"errors"
	"strings"
)

// NormalizeTurnStatus maps raw status strictly to exactly: inProgress, completed, failed, interrupted.
// No arbitrary aliases like success/done/error are accepted.
func NormalizeTurnStatus(raw string) (string, error) {
	switch strings.TrimSpace(raw) {
	case "inProgress":
		return "inProgress", nil
	case "completed":
		return "completed", nil
	case "failed":
		return "failed", nil
	case "interrupted":
		return "interrupted", nil
	default:
		return "", errors.New("unrecognized turn status")
	}
}

func ExtractTurnOutput(turnMap map[string]any) (string, error) {
	items, ok := turnMap["items"].([]any)
	if !ok || items == nil {
		return "", errors.New("turn output items unavailable")
	}
	var agentOutputs []string

	for _, rawItem := range items {
		item, ok := rawItem.(map[string]any)
		if !ok {
			return "", errors.New("turn output item invalid")
		}
		itemType, ok := item["type"].(string)
		if !ok || itemType == "" {
			return "", errors.New("turn output item type unavailable")
		}
		if itemType == "agentMessage" {
			text, ok := item["text"].(string)
			if !ok {
				return "", errors.New("turn output text unavailable")
			}
			text = strings.TrimSpace(text)
			if text != "" {
				agentOutputs = append(agentOutputs, text)
			}
		}
	}

	if len(agentOutputs) == 0 {
		return "", nil
	}

	combined := strings.Join(agentOutputs, "\n\n")
	return TruncateText(combined, MaxReadLineLength), nil
}

// ExtractTurnError provides static sanitized error descriptions without leaking upstream error payloads or keys.
func ExtractTurnError(normalizedStatus string) string {
	switch normalizedStatus {
	case "failed":
		return "turn failed"
	case "interrupted":
		return "turn interrupted"
	default:
		return ""
	}
}
