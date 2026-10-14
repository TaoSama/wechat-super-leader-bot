package desktop

import (
	"context"
	"sync"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/internal/threadstate"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	desktopHistoryTargetLimit  = 4
	desktopHistoryIdleTTL      = 60 * time.Second
	desktopHistoryCursorLimit  = 256
	desktopHistoryRawLimit     = desktopInboundFrameLimit
	desktopHistoryClient       = "super-leader-readonly-history"
	desktopLoadCompleteHistory = "thread-follower-load-complete-history"
)

type DesktopHistoryReader struct {
	socketPath       string
	mu               sync.Mutex
	entries          map[string]*desktopHistoryEntry
	idleTTL          time.Duration
	operationTimeout time.Duration
}

type desktopHistoryAnchor struct{ turnID, itemID string }

type desktopHistoryEntry struct {
	sessionID, generation               string
	ctx                                 context.Context
	cancel                              context.CancelFunc
	done                                chan struct{}
	wake                                chan struct{}
	mu                                  sync.Mutex
	changed                             chan struct{}
	err                                 error
	view                                desktopHistoryView
	ready, loadRequested, loadResponded bool
	loadRevision, revision              uint64
	raw                                 []byte
	order                               []desktopHistoryAnchor
	cursors                             map[string]desktopHistoryAnchor
	anchorTokens                        map[desktopHistoryAnchor]string
	lastUsed                            time.Time
	active                              int
	delivered                           bool
}

func NewDesktopHistoryReader(socketPath string) *DesktopHistoryReader {
	return &DesktopHistoryReader{socketPath: socketPath, entries: map[string]*desktopHistoryEntry{}, idleTTL: desktopHistoryIdleTTL, operationTimeout: desktopOwnerTimeout}
}

// Reset waits for subscriptions and framing readers to stop before permitting
// new entries. It is reusable and never changes another desktop capability.
func (r *DesktopHistoryReader) Reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, entry := range r.entries {
		entry.cancel()
	}
	for _, entry := range r.entries {
		<-entry.done
	}
	r.entries = map[string]*desktopHistoryEntry{}
}

func (r *DesktopHistoryReader) acquire(sessionID, generation string) (*desktopHistoryEntry, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, entry := range r.entries {
		entry.mu.Lock()
		expired := entry.err != nil || (entry.active == 0 && time.Since(entry.lastUsed) >= r.idleTTL)
		entry.mu.Unlock()
		if expired {
			entry.cancel()
			<-entry.done
			delete(r.entries, id)
		}
	}
	entry := r.entries[sessionID]
	if generation != "" && (entry == nil || entry.generation != generation) {
		return nil, historyError(protocol.HistoryContextExpired)
	}
	if entry == nil {
		if len(r.entries) >= desktopHistoryTargetLimit {
			return nil, historyError(protocol.HistoryBusy)
		}
		id, err := protocol.NewDispatchID()
		if err != nil {
			return nil, historyError(protocol.HistoryFailed)
		}
		ctx, cancel := context.WithCancel(context.Background())
		entry = &desktopHistoryEntry{sessionID: sessionID, generation: id, ctx: ctx, cancel: cancel, done: make(chan struct{}), wake: make(chan struct{}, 1),
			changed: make(chan struct{}), cursors: map[string]desktopHistoryAnchor{}, anchorTokens: map[desktopHistoryAnchor]string{}, lastUsed: time.Now()}
		r.entries[sessionID] = entry
		go r.run(entry)
	}
	entry.mu.Lock()
	entry.active++
	entry.lastUsed = time.Now()
	entry.mu.Unlock()
	return entry, nil
}

func (r *DesktopHistoryReader) ReadHistory(ctx context.Context, sessionID, generation, cursor string, limit int) (protocol.SessionHistory, string, error) {
	if !protocol.ValidHistoryIdentity(sessionID) || !protocol.ValidTurnID(sessionID) || len(cursor) > protocol.MaxHistoryCursorLength ||
		(generation != "" && !protocol.ValidHistoryIdentity(generation)) || (cursor != "" && generation == "") || limit < 0 || limit > protocol.MaxHistoryLimit {
		return protocol.SessionHistory{}, "", historyError(protocol.HistoryInvalidRequest)
	}
	if err := ctx.Err(); err != nil {
		return protocol.SessionHistory{}, "", err
	}
	if limit == 0 {
		limit = protocol.DefaultHistoryLimit
	}
	entry, err := r.acquire(sessionID, generation)
	if err != nil {
		return protocol.SessionHistory{}, "", err
	}
	defer func() { entry.mu.Lock(); entry.active--; entry.lastUsed = time.Now(); entry.mu.Unlock() }()
	for {
		if err := ctx.Err(); err != nil {
			return protocol.SessionHistory{}, "", err
		}
		entry.mu.Lock()
		if entry.err != nil {
			err = entry.err
			entry.mu.Unlock()
			return protocol.SessionHistory{}, "", err
		}
		if cursor != "" {
			if _, exists := entry.cursors[cursor]; !exists {
				entry.mu.Unlock()
				return protocol.SessionHistory{}, "", historyError(protocol.HistoryContextExpired)
			}
		}
		loadReady := !entry.loadRequested || (entry.loadResponded && entry.revision >= entry.loadRevision)
		if entry.ready && loadReady {
			if entry.view.complete {
				history, err := entry.pageLocked(cursor, limit)
				if err == nil {
					entry.delivered = true
				}
				entry.mu.Unlock()
				if err != nil {
					return protocol.SessionHistory{}, "", err
				}
				return history, entry.generation, nil
			}
			if entry.loadRequested {
				entry.mu.Unlock()
				return protocol.SessionHistory{}, "", historyError(protocol.HistoryIncomplete)
			}
		}
		changed := entry.changed
		entry.mu.Unlock()
		select {
		case entry.wake <- struct{}{}:
		default:
		}
		select {
		case <-ctx.Done():
			return protocol.SessionHistory{}, "", ctx.Err()
		case <-changed:
		}
	}
}

func (entry *desktopHistoryEntry) notifyLocked() {
	close(entry.changed)
	entry.changed = make(chan struct{})
}

func (entry *desktopHistoryEntry) pageLocked(cursor string, limit int) (protocol.SessionHistory, error) {
	end := len(entry.view.items)
	if cursor != "" {
		anchor := entry.cursors[cursor]
		found := false
		for i, item := range entry.view.items {
			if item.TurnID == anchor.turnID && item.ID == anchor.itemID {
				end = i
				found = true
				break
			}
		}
		if !found {
			return protocol.SessionHistory{}, historyError(protocol.HistoryContextExpired)
		}
	}
	start := max(0, end-limit)
	history := protocol.SessionHistory{HistoryContext: entry.generation, Source: protocol.HistorySourceDesktop, Session: entry.view.session,
		Items: append([]protocol.HistoryItem{}, entry.view.items[start:end]...), FetchedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	if start > 0 {
		item := entry.view.items[start]
		anchor := desktopHistoryAnchor{turnID: item.TurnID, itemID: item.ID}
		token := entry.anchorTokens[anchor]
		if token == "" {
			if len(entry.cursors) >= desktopHistoryCursorLimit {
				return protocol.SessionHistory{}, historyError(protocol.HistoryTooLarge)
			}
			var err error
			token, err = protocol.NewDispatchID()
			if err != nil {
				return protocol.SessionHistory{}, historyError(protocol.HistoryFailed)
			}
			entry.cursors[token], entry.anchorTokens[anchor] = anchor, token
		}
		history.NextCursor = &token
	}
	for _, item := range history.Items {
		history.Truncated = history.Truncated || item.Truncated
	}
	if err := threadstate.BoundHistoryResponse(&history); err != nil {
		return protocol.SessionHistory{}, err
	}
	return history, nil
}
