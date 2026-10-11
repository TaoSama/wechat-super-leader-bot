package codex

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const maxDiscoveryPages = 100
const maxSessionMetadataLength = 4096

func pageCursor(raw any, seen map[string]bool) (string, error) {
	if raw == nil || raw == "" {
		return "", nil
	}
	cursor, ok := raw.(string)
	if !ok || len(cursor) > protocol.MaxHistoryCursorLength || seen[cursor] {
		return "", errors.New("invalid or repeated pagination cursor")
	}
	seen[cursor] = true
	return cursor, nil
}

func sessionFromThread(thread map[string]any, loaded bool, observedAt string) protocol.Session {
	status := extractStatus(thread["status"])
	loaded = loaded && status != "unknown" && status != "notLoaded"
	caps := []protocol.ActionType{protocol.ActionRead}
	if loaded && status == "idle" {
		caps = append(caps, protocol.ActionSend)
	}
	return protocol.Session{
		ID: extractString(thread, "id"), Provider: ProviderCodexApp,
		Title:  clipHistoryText(extractString(thread, "title", "name", "preview"), maxSessionMetadataLength),
		Cwd:    clipHistoryText(extractString(thread, "cwd", "path"), maxSessionMetadataLength),
		Status: clipHistoryText(status, protocol.MaxHistoryIdentityLength), Capabilities: caps, ObservedAt: observedAt,
		Model:           clipHistoryText(extractString(thread, "model"), protocol.MaxHistoryIdentityLength),
		ModelProvider:   clipHistoryText(extractString(thread, "modelProvider"), protocol.MaxHistoryIdentityLength),
		ReasoningEffort: clipHistoryText(extractString(thread, "reasoningEffort"), protocol.MaxHistoryIdentityLength),
		UpdatedAt:       nativeTimestamp(thread["updatedAt"], false),
		Preview:         clipHistoryText(extractString(thread, "preview"), maxSessionMetadataLength), Loaded: &loaded,
	}
}

// nativeTimestamp accepts native Unix seconds or item timestamps in milliseconds.
func nativeTimestamp(raw any, milliseconds bool) string {
	if value, ok := raw.(string); ok {
		parsed, err := time.Parse(time.RFC3339Nano, value)
		if err == nil {
			return parsed.UTC().Format(time.RFC3339Nano)
		}
		return ""
	}
	value, ok := raw.(float64)
	if !ok || value <= 0 || math.IsNaN(value) || math.IsInf(value, 0) || value > 253402300799000 {
		return ""
	}
	if milliseconds {
		value /= 1000
	}
	seconds, fraction := math.Modf(value)
	if seconds > 253402300799 {
		return ""
	}
	return time.Unix(int64(seconds), int64(fraction*float64(time.Second))).UTC().Format(time.RFC3339Nano)
}

func (a *AppServerAdapter) discoverPages(ctx context.Context, rc *rpcConn, loadedSet map[string]bool) ([]protocol.Session, error) {
	nowISO := time.Now().UTC().Format(time.RFC3339Nano)
	sessions := []protocol.Session{}
	seenIDs, seenCursors := map[string]bool{}, map[string]bool{}
	cursor := ""
	for page := 0; ; page++ {
		if page >= maxDiscoveryPages {
			return nil, errors.New("session pagination limit exceeded")
		}
		params := map[string]any{"limit": DefaultListLimit, "useStateDbOnly": true, "sourceKinds": []string{"cli", "vscode", "appServer"}}
		if cursor != "" {
			params["cursor"] = cursor
		}
		res, err := rc.call(ctx, "thread/list", params, a.rpcTimeout)
		if err != nil {
			return nil, fmt.Errorf("thread/list failed: %w", err)
		}
		items, ok := res["data"].([]any)
		if !ok {
			return nil, errors.New("thread/list returned invalid data")
		}
		for _, raw := range items {
			thread, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			id := extractString(thread, "id")
			if !protocol.ValidHistoryIdentity(id) || seenIDs[id] {
				continue
			}
			seenIDs[id] = true
			sessions = append(sessions, sessionFromThread(thread, loadedSet[id], nowISO))
		}
		cursor, err = pageCursor(res["nextCursor"], seenCursors)
		if err != nil {
			return nil, err
		}
		if cursor == "" {
			break
		}
	}
	// Loaded threads omitted by the state DB still need current native metadata.
	missingIDs := []string{}
	for id := range loadedSet {
		if !seenIDs[id] {
			missingIDs = append(missingIDs, id)
		}
	}
	sort.Strings(missingIDs)
	for _, id := range missingIDs {
		res, err := rc.call(ctx, "thread/read", map[string]any{"threadId": id, "includeTurns": false}, a.rpcTimeout)
		thread, ok := res["thread"].(map[string]any)
		if err != nil || !ok || extractString(thread, "id") != id {
			thread = map[string]any{"id": id, "title": id, "status": "unknown"}
		}
		sessions = append(sessions, sessionFromThread(thread, true, nowISO))
	}
	return sessions, nil
}
