package appserver

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sort"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/internal/threadstate"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const maxDiscoveryPages = 100

func (a *AppServerAdapter) InspectSession(ctx context.Context, sessionID string) (protocol.Session, error) {
	if !protocol.ValidHistoryIdentity(sessionID) {
		return protocol.Session{}, errors.New("invalid session identity")
	}
	rc, err := a.connect(ctx)
	if err != nil {
		return protocol.Session{}, err
	}
	defer rc.closeLogged()
	thread, err := a.readSendTarget(ctx, rc, sessionID)
	if err != nil {
		return protocol.Session{}, err
	}
	// Reading a thread proves its current state, not loaded membership. Explicit
	// resume-send will check membership and acquire the writer before sending.
	return sessionFromThread(thread, false, time.Now().UTC().Format(time.RFC3339Nano)), nil
}

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
	if status == "notLoaded" || status == "idle" {
		caps = append(caps, protocol.CapabilityResumeSend)
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
	sourceKinds := []string{"cli", "vscode", "appServer"}
	sessions := []protocol.Session{}
	seenIDs, seenCursors := map[string]bool{}, map[string]bool{}
	cursor := ""
	for page := 0; ; page++ {
		if page >= maxDiscoveryPages {
			return nil, errors.New("session pagination limit exceeded")
		}
		params := map[string]any{"limit": DefaultListLimit, "useStateDbOnly": true, "sourceKinds": sourceKinds}
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
	// Loaded membership includes internal agents excluded by the filtered list.
	// Supplement only exact identities with a verified user-facing source.
	missingIDs := []string{}
	for id := range loadedSet {
		if !seenIDs[id] {
			missingIDs = append(missingIDs, id)
		}
	}
	sort.Strings(missingIDs)
	for _, id := range missingIDs {
		res, err := rc.call(ctx, "thread/read", map[string]any{"threadId": id, "includeTurns": false}, a.rpcTimeout)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		thread, ok := res["thread"].(map[string]any)
		if err != nil || !ok || thread["id"] != id {
			continue
		}
		source, ok := thread["source"].(string)
		if !ok || !slices.Contains(sourceKinds, source) {
			continue
		}
		sessions = append(sessions, sessionFromThread(thread, true, nowISO))
	}
	return sessions, nil
}
