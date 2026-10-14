package appserver

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/internal/threadstate"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const maxDiscoveryPages = 100

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
	status := threadstate.ExtractStatus(thread["status"])
	loaded = loaded && status != "unknown" && status != "notLoaded"
	caps := []protocol.ActionType{protocol.ActionRead}
	if loaded && status == "idle" {
		caps = append(caps, protocol.ActionSend)
	}
	return protocol.Session{
		ID: threadstate.ExtractString(thread, "id"), Provider: codex.ProviderCodexApp,
		Title:  threadstate.ClipHistoryText(threadstate.ExtractString(thread, "title", "name", "preview"), threadstate.MaxSessionMetadataLength),
		Cwd:    threadstate.ClipHistoryText(threadstate.ExtractString(thread, "cwd", "path"), threadstate.MaxSessionMetadataLength),
		Status: threadstate.ClipHistoryText(status, protocol.MaxHistoryIdentityLength), Capabilities: caps, ObservedAt: observedAt,
		Model:           threadstate.ClipHistoryText(threadstate.ExtractString(thread, "model"), protocol.MaxHistoryIdentityLength),
		ModelProvider:   threadstate.ClipHistoryText(threadstate.ExtractString(thread, "modelProvider"), protocol.MaxHistoryIdentityLength),
		ReasoningEffort: threadstate.ClipHistoryText(threadstate.ExtractString(thread, "reasoningEffort"), protocol.MaxHistoryIdentityLength),
		UpdatedAt:       threadstate.NativeTimestamp(thread["updatedAt"], false),
		Preview:         threadstate.ClipHistoryText(threadstate.ExtractString(thread, "preview"), threadstate.MaxSessionMetadataLength), Loaded: &loaded,
	}
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
			id := threadstate.ExtractString(thread, "id")
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
		if err != nil || !ok || threadstate.ExtractString(thread, "id") != id {
			thread = map[string]any{"id": id, "title": id, "status": "unknown"}
		}
		sessions = append(sessions, sessionFromThread(thread, true, nowISO))
	}
	return sessions, nil
}
