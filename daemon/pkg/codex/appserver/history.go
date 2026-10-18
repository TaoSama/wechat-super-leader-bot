package appserver

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/internal/threadstate"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

// PagedHistoryAvailable declares that tail reads use native bounded pagination.
func (a *AppServerAdapter) PagedHistoryAvailable() bool { return true }

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
	params := map[string]any{"threadId": sessionID, "sortDirection": "desc", "limit": limit}
	if cursor != "" {
		params["cursor"] = cursor
	}
	// History carries read-only metadata. Loaded state and send authority come
	// from session discovery, so a tail read never walks every loaded thread.
	var metadata, page map[string]any
	var metadataErr, pageErr error
	readCtx, cancelReads := context.WithCancel(ctx)
	defer cancelReads()
	var reads sync.WaitGroup
	reads.Add(2)
	go func() {
		defer reads.Done()
		metadata, metadataErr = rc.call(readCtx, "thread/read", map[string]any{"threadId": sessionID, "includeTurns": false}, a.rpcTimeout)
	}()
	go func() {
		defer reads.Done()
		page, pageErr = rc.call(readCtx, "thread/items/list", params, a.rpcTimeout)
		if pageErr != nil {
			cancelReads()
		}
	}()
	reads.Wait()
	if pageErr != nil {
		return empty, errors.New(protocol.HistoryUnavailable)
	}
	if metadataErr != nil {
		return empty, errors.New(protocol.HistoryFailed)
	}
	thread, ok := metadata["thread"].(map[string]any)
	if !ok || threadstate.ExtractString(thread, "id") != sessionID {
		return empty, errors.New(protocol.HistoryFailed)
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
	session := sessionFromThread(thread, false, now)
	session.Capabilities = []protocol.ActionType{protocol.ActionRead}
	history := protocol.SessionHistory{Session: session, Items: []protocol.HistoryItem{}, FetchedAt: now}
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
