package appserver

import (
	"context"
	"errors"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/internal/threadstate"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

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
	if !ok || threadstate.ExtractString(thread, "id") != sessionID {
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
		item, include := threadstate.PublicHistoryItem(wrapper)
		if !include {
			continue
		}
		history.Truncated = history.Truncated || item.Truncated
		history.Items = append(history.Items, item)
	}
	if err := threadstate.BoundHistoryResponse(&history); err != nil {
		return empty, err
	}
	return history, nil
}
