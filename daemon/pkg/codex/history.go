package codex

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

// HistoryReader is optional so existing session adapters retain their contract.
type HistoryReader interface {
	ReadHistory(context.Context, string, string, int) (protocol.SessionHistory, error)
}

const historyEnvelopeReserveBytes = 16 * 1024

func (a *AppServerAdapter) ReadHistory(ctx context.Context, sessionID, cursor string, limit int) (protocol.SessionHistory, error) {
	var empty protocol.SessionHistory
	if !protocol.ValidHistoryIdentity(sessionID) || len(cursor) > protocol.MaxHistoryCursorLength || limit < 0 || limit > protocol.MaxHistoryLimit {
		return empty, errors.New(protocol.HistoryInvalidRequest)
	}
	if limit == 0 {
		limit = protocol.DefaultHistoryLimit
	}
	rc, err := a.connect(ctx)
	if err != nil {
		return empty, errors.New(protocol.HistoryUnavailable)
	}
	defer rc.closeLogged()
	loadedSet, err := rc.getLoadedSet(ctx, a.rpcTimeout)
	if err != nil {
		return empty, errors.New(protocol.HistoryFailed)
	}
	metadata, err := rc.call(ctx, "thread/read", map[string]any{"threadId": sessionID, "includeTurns": false}, a.rpcTimeout)
	if err != nil {
		return empty, errors.New(protocol.HistoryFailed)
	}
	thread, ok := metadata["thread"].(map[string]any)
	if !ok || extractString(thread, "id") != sessionID {
		return empty, errors.New(protocol.HistoryFailed)
	}
	params := map[string]any{"threadId": sessionID, "sortDirection": "desc", "limit": limit}
	if cursor != "" {
		params["cursor"] = cursor
	}
	page, err := rc.call(ctx, "thread/items/list", params, a.rpcTimeout)
	if err != nil {
		return empty, errors.New(protocol.HistoryUnavailable)
	}
	rawItems, ok := page["data"].([]any)
	if !ok || len(rawItems) > limit {
		return empty, errors.New(protocol.HistoryFailed)
	}
	seen := map[string]bool{}
	if cursor != "" {
		seen[cursor] = true
	}
	next, err := pageCursor(page["nextCursor"], seen)
	if err != nil {
		return empty, errors.New(protocol.HistoryFailed)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	history := protocol.SessionHistory{Session: sessionFromThread(thread, loadedSet[sessionID], now), Items: []protocol.HistoryItem{}, FetchedAt: now}
	if next != "" {
		history.NextCursor = &next
	}
	// Native desc pages list newest first. The public page reads oldest to newest.
	for i := len(rawItems) - 1; i >= 0; i-- {
		wrapper, ok := rawItems[i].(map[string]any)
		if !ok {
			continue
		}
		item, include := publicHistoryItem(wrapper)
		if !include {
			continue
		}
		history.Truncated = history.Truncated || item.Truncated
		history.Items = append(history.Items, item)
	}
	if err := boundHistoryResponse(&history); err != nil {
		return empty, err
	}
	return history, nil
}

// clipHistoryText bounds bytes, including multi-byte characters, before JSON encoding.
func clipHistoryText(text string, maxBytes int) string {
	if len(text) <= maxBytes {
		return text
	}
	end := maxBytes
	for end > 0 && !utf8.RuneStart(text[end]) {
		end--
	}
	return text[:end]
}

func publicHistoryItem(wrapper map[string]any) (protocol.HistoryItem, bool) {
	raw, ok := wrapper["item"].(map[string]any)
	if !ok {
		return protocol.HistoryItem{}, false
	}
	typeName := extractString(raw, "type")
	item := protocol.HistoryItem{ID: extractString(raw, "id"), TurnID: extractString(wrapper, "turnId"), Type: typeName}
	if !protocol.ValidHistoryIdentity(item.ID) || !protocol.ValidTurnID(item.TurnID) {
		return item, false
	}
	switch typeName {
	case "userMessage":
		item.Kind, item.Text = "user", publicTextContent(raw["content"])
	case "agentMessage":
		item.Kind, item.Text = "assistant", extractString(raw, "text")
	case "commandExecution":
		item.Kind, item.Text, item.Title = "tool", extractString(raw, "aggregatedOutput"), extractString(raw, "command")
	case "fileChange":
		item.Kind, item.Title = "tool", "File changes"
		changes, _ := raw["changes"].([]any)
		parts := []string{}
		for _, entry := range changes {
			change, ok := entry.(map[string]any)
			if !ok {
				continue
			}
			parts = append(parts, extractString(change, "path")+"\n"+extractString(change, "diff"))
		}
		item.Text = strings.Join(parts, "\n")
	case "mcpToolCall":
		item.Kind, item.Title = "tool", extractString(raw, "server")+" / "+extractString(raw, "tool")
		if result, ok := raw["result"].(map[string]any); ok {
			item.Text = publicTextContent(result["content"])
		}
	case "dynamicToolCall":
		item.Kind, item.Title, item.Text = "tool", extractString(raw, "tool"), publicTextContent(raw["contentItems"])
	case "functionCallOutput":
		// Desktop input injection can be represented as a function output. Retain
		// its native tool kind; never infer the author from the output text.
		item.Kind, item.Title, item.Text = "tool", "Tool result", extractString(raw, "output")
	case "webSearch":
		item.Kind, item.Title = "tool", "Web search"
		if action, ok := raw["action"].(map[string]any); ok {
			item.Text = extractString(action, "query", "url")
		}
	case "enteredReviewMode", "exitedReviewMode":
		item.Kind, item.Text = "system", extractString(raw, "review")
	case "contextCompaction":
		item.Kind, item.Text = "system", "Context compacted"
	default:
		// Reasoning, plans, binary artifacts and future unknown objects are private.
		return item, false
	}
	item.Status = clipHistoryText(extractString(raw, "status"), protocol.MaxHistoryIdentityLength)
	item.Timestamp = nativeTimestamp(wrapper["completedAtMs"], true)
	if item.Timestamp == "" {
		item.Timestamp = nativeTimestamp(wrapper["startedAtMs"], true)
	}
	text, title := item.Text, item.Title
	item.Text = clipHistoryText(text, protocol.MaxHistoryTextLength)
	item.Title = clipHistoryText(title, maxSessionMetadataLength)
	item.Truncated = item.Text != text || item.Title != title
	return item, true
}

func publicTextContent(raw any) string {
	content, _ := raw.([]any)
	parts := []string{}
	for _, entry := range content {
		block, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		switch block["type"] {
		case "text", "inputText":
			parts = append(parts, extractString(block, "text"))
		case "image", "localImage", "inputImage":
			parts = append(parts, "[Image]")
		}
	}
	return strings.Join(parts, "\n")
}

func boundHistoryResponse(history *protocol.SessionHistory) error {
	for {
		encoded, err := json.Marshal(history)
		if err != nil {
			return errors.New(protocol.HistoryFailed)
		}
		if len(encoded) < protocol.MaxHistoryResponseBytes-historyEnvelopeReserveBytes {
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
		*longest = clipHistoryText(*longest, len(*longest)/2)
		item.Truncated, history.Truncated = true, true
	}
}
