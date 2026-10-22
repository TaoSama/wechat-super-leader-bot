package appserver

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/internal/threadstate"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	historyTurnCacheLimit      = 16
	historyTurnStatusLimit     = protocol.MaxHistoryTurnStatuses
	historyTurnPageLimit       = 50
	historyTurnPagesPerRead    = 3
	historyTurnRefresh         = 2 * time.Second
	historyTurnCacheTTL        = 10 * time.Minute
	historyTurnMetadataTimeout = time.Second
	historyTurnDeadlineReserve = 100 * time.Millisecond
)

type historyTurnCache struct {
	mu                        sync.Mutex
	lastUsed                  time.Time // guarded by historyTurnsMu
	statuses                  map[string]string
	latestIDs                 map[string]bool
	wanted                    map[string]bool
	order                     []string
	cursor                    string
	latestAt                  time.Time
	scanStarted, scanComplete bool
}

func (a *AppServerAdapter) turnCache(sessionID string) *historyTurnCache {
	a.historyTurnsMu.Lock()
	defer a.historyTurnsMu.Unlock()
	now := time.Now()
	if a.historyTurns == nil {
		a.historyTurns = make(map[string]*historyTurnCache)
	}
	for id, entry := range a.historyTurns {
		if now.Sub(entry.lastUsed) >= historyTurnCacheTTL {
			delete(a.historyTurns, id)
		}
	}
	if entry := a.historyTurns[sessionID]; entry != nil {
		entry.lastUsed = now
		return entry
	}
	if len(a.historyTurns) >= historyTurnCacheLimit {
		oldestID := ""
		var oldest time.Time
		for id, entry := range a.historyTurns {
			if oldestID == "" || entry.lastUsed.Before(oldest) {
				oldestID, oldest = id, entry.lastUsed
			}
		}
		delete(a.historyTurns, oldestID)
	}
	entry := &historyTurnCache{lastUsed: now, statuses: map[string]string{}, wanted: map[string]bool{}}
	a.historyTurns[sessionID] = entry
	return entry
}

func (a *AppServerAdapter) enrichHistoryTurns(ctx context.Context, rc *rpcConn, sessionID string, history *protocol.SessionHistory) {
	entry := a.turnCache(sessionID)
	// Concurrent views of the same target never queue behind optional metadata.
	if !entry.mu.TryLock() {
		return
	}
	defer entry.mu.Unlock()
	for _, item := range history.Items {
		if !entry.wanted[item.TurnID] {
			if len(entry.order) >= historyTurnStatusLimit {
				oldest := entry.order[0]
				entry.order = entry.order[1:]
				delete(entry.wanted, oldest)
				delete(entry.statuses, oldest)
			}
			entry.wanted[item.TurnID] = true
			entry.order = append(entry.order, item.TurnID)
			// A previously completed scan predates this newly requested target.
			if entry.scanComplete && entry.statuses[item.TurnID] == "" {
				entry.scanStarted, entry.scanComplete, entry.cursor = false, false, ""
			}
		}
	}
	if len(entry.wanted) == 0 {
		return
	}
	if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) < historyTurnMetadataTimeout+historyTurnDeadlineReserve {
		entry.apply(history)
		return
	}
	if entry.scanComplete && entry.missing() {
		// A later request may target a turn scanned before it was wanted. A
		// bounded second pass can discover it without retaining every past turn.
		entry.scanStarted, entry.scanComplete, entry.cursor = false, false, ""
	}
	readCtx, cancel := context.WithTimeout(ctx, historyTurnMetadataTimeout)
	defer cancel()
	remaining := historyTurnPagesPerRead
	if time.Since(entry.latestAt) >= historyTurnRefresh {
		page, err := a.readHistoryTurnPage(readCtx, rc, sessionID, "")
		remaining--
		if err == nil {
			entry.latestAt = time.Now()
			entry.latestIDs = make(map[string]bool)
			for _, value := range page["data"].([]any) {
				if turn, ok := value.(map[string]any); ok {
					entry.latestIDs[threadstate.ExtractString(turn, "id")] = true
				}
			}
			entry.remember(page)
			if !entry.scanStarted {
				entry.advance(page)
			}
		} else {
			// Readable item history remains valid even when this API is absent.
			remaining = 0
		}
	}
	for remaining > 0 && !entry.scanComplete && entry.missing() {
		page, err := a.readHistoryTurnPage(readCtx, rc, sessionID, entry.cursor)
		if err != nil {
			break // Preserve progress and retry the same metadata cursor next read.
		}
		entry.remember(page)
		if !entry.advance(page) {
			break
		}
		remaining--
	}
	entry.apply(history)
}

func (entry *historyTurnCache) apply(history *protocol.SessionHistory) {
	if len(entry.statuses) > 0 {
		history.TurnStatuses = make(map[string]string, len(entry.statuses))
		for id, status := range entry.statuses {
			history.TurnStatuses[id] = status
		}
		for i := range history.Items {
			history.Items[i].TurnStatus = entry.statuses[history.Items[i].TurnID]
		}
	}
}

func (a *AppServerAdapter) readHistoryTurnPage(ctx context.Context, rc *rpcConn, sessionID, cursor string) (map[string]any, error) {
	params := map[string]any{"threadId": sessionID, "sortDirection": "desc", "limit": historyTurnPageLimit, "itemsView": "notLoaded"}
	if cursor != "" {
		params["cursor"] = cursor
	}
	page, err := rc.call(ctx, "thread/turns/list", params, a.rpcTimeout)
	if err != nil {
		return nil, err
	}
	data, ok := page["data"].([]any)
	if !ok || len(data) > historyTurnPageLimit {
		return nil, errors.New(protocol.HistoryFailed)
	}
	if _, err := pageCursor(page["nextCursor"], map[string]bool{cursor: cursor != ""}); err != nil {
		return nil, errors.New(protocol.HistoryFailed)
	}
	return page, nil
}

func (entry *historyTurnCache) missing() bool {
	for id := range entry.wanted {
		if entry.statuses[id] == "" || entry.statuses[id] == "inProgress" && !entry.latestIDs[id] {
			return true
		}
	}
	return false
}

func (entry *historyTurnCache) remember(page map[string]any) {
	for _, value := range page["data"].([]any) {
		turn, ok := value.(map[string]any)
		if !ok {
			continue
		}
		id := threadstate.ExtractString(turn, "id")
		status, err := threadstate.NormalizeTurnStatus(threadstate.ExtractString(turn, "status"))
		if !protocol.ValidTurnID(id) || err != nil {
			continue
		}
		if entry.statuses[id] == "" && len(entry.statuses) >= historyTurnStatusLimit {
			// Keep requested reading windows while bounding unrelated metadata
			// encountered on the way to an older turn.
			if !entry.wanted[id] {
				continue
			}
			for cachedID := range entry.statuses {
				if !entry.wanted[cachedID] {
					delete(entry.statuses, cachedID)
					break
				}
			}
		}
		entry.statuses[id] = status
	}
}

func (entry *historyTurnCache) advance(page map[string]any) bool {
	next, _ := page["nextCursor"].(string)
	if next != "" && next == entry.cursor {
		return false
	}
	entry.cursor, entry.scanStarted, entry.scanComplete = next, true, next == ""
	return true
}
