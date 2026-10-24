package threadstate

import (
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

// ClipHistoryText bounds bytes, including multi-byte characters, before JSON encoding.
func ClipHistoryText(text string, maxBytes int) string {
	if len(text) <= maxBytes {
		return text
	}
	end := maxBytes
	for end > 0 && !utf8.RuneStart(text[end]) {
		end--
	}
	return text[:end]
}

func PublicHistoryItem(wrapper map[string]any) (protocol.HistoryItem, bool) {
	raw, ok := wrapper["item"].(map[string]any)
	if !ok {
		return protocol.HistoryItem{}, false
	}
	typeName := ExtractString(raw, "type")
	item := protocol.HistoryItem{ID: ExtractString(raw, "id"), TurnID: ExtractString(wrapper, "turnId"), Type: typeName}
	if status, err := NormalizeTurnStatus(ExtractString(wrapper, "turnStatus")); err == nil {
		item.TurnStatus = status
	}
	if !protocol.ValidHistoryIdentity(item.ID) || !protocol.ValidTurnID(item.TurnID) {
		return item, false
	}
	switch typeName {
	case "userMessage":
		item.Kind, item.Text = "user", PublicTextContent(raw["content"])
	case "agentMessage":
		item.Kind, item.Text = "assistant", rawHistoryText(raw, "text")
	case "commandExecution":
		item.Kind, item.Text, item.Title = "tool", rawHistoryText(raw, "aggregatedOutput"), ExtractString(raw, "command")
	case "fileChange":
		item.Kind, item.Title = "tool", "File changes"
		changes, _ := raw["changes"].([]any)
		parts := []string{}
		for _, entry := range changes {
			change, ok := entry.(map[string]any)
			if !ok {
				continue
			}
			parts = append(parts, ExtractString(change, "path")+"\n"+rawHistoryText(change, "diff"))
		}
		item.Text = strings.Join(parts, "\n")
	case "mcpToolCall":
		item.Kind, item.Title = "tool", ExtractString(raw, "server")+" / "+ExtractString(raw, "tool")
		if result, ok := raw["result"].(map[string]any); ok {
			item.Text = PublicTextContent(result["content"])
		}
	case "dynamicToolCall":
		item.Kind, item.Title, item.Text = "tool", ExtractString(raw, "tool"), PublicTextContent(raw["contentItems"])
	case "functionCallOutput":
		// Desktop input injection can be represented as a function output. Retain
		// its native tool kind; never infer the author from the output text.
		item.Kind, item.Title, item.Text = "tool", "Tool result", rawHistoryText(raw, "output")
	case "webSearch":
		item.Kind, item.Title = "tool", "Web search"
		if action, ok := raw["action"].(map[string]any); ok {
			item.Text = ExtractString(action, "query", "url")
		}
	case "enteredReviewMode", "exitedReviewMode":
		item.Kind, item.Text = "system", rawHistoryText(raw, "review")
	case "contextCompaction":
		item.Kind, item.Text = "system", "Context compacted"
	default:
		// Reasoning, plans, binary artifacts and future unknown objects are private.
		return item, false
	}
	item.Status = ClipHistoryText(ExtractString(raw, "status"), protocol.MaxHistoryIdentityLength)
	item.Timestamp = NativeTimestamp(wrapper["completedAtMs"], true)
	if item.Timestamp == "" {
		item.Timestamp = NativeTimestamp(wrapper["startedAtMs"], true)
	}
	text, title := item.Text, item.Title
	item.Text = ClipHistoryText(text, protocol.MaxHistoryTextLength)
	item.Title = ClipHistoryText(title, MaxSessionMetadataLength)
	item.Truncated = item.Text != text || item.Title != title
	return item, true
}

// Body whitespace affects Markdown and copied output, including whitespace-only text.
func rawHistoryText(raw map[string]any, key string) string {
	text, _ := raw[key].(string)
	return text
}

func PublicTextContent(raw any) string {
	content, _ := raw.([]any)
	parts := []string{}
	for _, entry := range content {
		block, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		switch block["type"] {
		case "text", "inputText":
			parts = append(parts, rawHistoryText(block, "text"))
		case "image", "localImage", "inputImage":
			parts = append(parts, "[Image]")
		}
	}
	return strings.Join(parts, "\n")
}

func BoundHistoryResponse(history *protocol.SessionHistory) error {
	for {
		encoded, err := json.Marshal(history)
		if err != nil {
			return errors.New(protocol.HistoryFailed)
		}
		if len(encoded) < protocol.MaxHistoryResponseBytes-HistoryEnvelopeReserveBytes {
			return nil
		}
		largest := -1
		var longest *string
		for i := range history.Items {
			item := &history.Items[i]
			for _, field := range []*string{&item.Text, &item.Title} {
				if longest == nil || len(*field) > len(*longest) {
					largest, longest = i, field
				}
			}
		}
		if longest == nil || len(*longest) == 0 {
			return errors.New(protocol.HistoryTooLarge)
		}
		item := &history.Items[largest]
		*longest = ClipHistoryText(*longest, len(*longest)/2)
		item.Truncated, history.Truncated = true, true
	}
}
