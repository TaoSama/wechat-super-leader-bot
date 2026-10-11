package client

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const maxHistoryContexts = 128
const maxHistoryContextCursors = 256
const historyContextIdleTTL = 10 * time.Minute

type desktopHistoryReader interface {
	ReadHistory(context.Context, string, string, string, int) (protocol.SessionHistory, string, error)
	Reset()
}

type terminalHistoryReader interface {
	desktopHistoryReader
	Supports(string) bool
}

type historyBinding struct {
	token, nodeID, sessionID, source, generation string
	expiresAt                                    time.Time
	gate                                         chan struct{}
	cursors                                      map[string]string
	cursorTokens                                 map[string]string
}

// Tokens never contain a backend cursor, socket, owner or session identity.
// Each binding is serialized independently; slow reads cannot block other targets.
type historyContexts struct {
	mu       sync.Mutex
	bindings map[string]*historyBinding
}

func newHistoryContexts() *historyContexts {
	return &historyContexts{bindings: make(map[string]*historyBinding)}
}

func (h *historyContexts) reset() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.bindings = make(map[string]*historyBinding)
}

func (h *historyContexts) forget(binding *historyBinding) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.bindings[binding.token] == binding {
		delete(h.bindings, binding.token)
	}
}

func (h *historyContexts) current(binding *historyBinding) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.bindings[binding.token] == binding && time.Now().Before(binding.expiresAt)
}

func (h *historyContexts) acquire(ctx context.Context, msg protocol.ReadHistoryMessage, source string) (*historyBinding, string, error) {
	h.mu.Lock()
	now := time.Now()
	for token, binding := range h.bindings {
		if !now.Before(binding.expiresAt) {
			delete(h.bindings, token)
		}
	}
	binding := h.bindings[msg.HistoryContext]
	if msg.HistoryContext == "" {
		if len(h.bindings) >= maxHistoryContexts {
			h.mu.Unlock()
			return nil, "", errors.New(protocol.HistoryBusy)
		}
		token, err := protocol.NewDispatchID()
		if err != nil {
			h.mu.Unlock()
			return nil, "", errors.New(protocol.HistoryFailed)
		}
		binding = &historyBinding{token: token, nodeID: msg.NodeID, sessionID: msg.SessionID, source: source,
			gate: make(chan struct{}, 1), cursors: make(map[string]string), cursorTokens: make(map[string]string)}
		h.bindings[token] = binding
	}
	if binding == nil || binding.nodeID != msg.NodeID || binding.sessionID != msg.SessionID {
		h.mu.Unlock()
		return nil, "", errors.New(protocol.HistoryContextExpired)
	}
	binding.expiresAt = now.Add(historyContextIdleTTL)
	h.mu.Unlock()
	select {
	case binding.gate <- struct{}{}:
	case <-ctx.Done():
		if msg.HistoryContext == "" {
			h.forget(binding)
		}
		return nil, "", ctx.Err()
	}
	if !h.current(binding) {
		<-binding.gate
		return nil, "", errors.New(protocol.HistoryContextExpired)
	}
	if msg.Cursor != "" {
		cursor, exists := binding.cursors[msg.Cursor]
		if !exists {
			<-binding.gate
			return nil, "", errors.New(protocol.HistoryContextExpired)
		}
		return binding, cursor, nil
	}
	return binding, "", nil
}

func (b *historyBinding) wrapCursor(cursor *string) (*string, error) {
	if cursor == nil {
		return nil, nil
	}
	if *cursor == "" || len(*cursor) > protocol.MaxHistoryCursorLength {
		return nil, errors.New(protocol.HistoryFailed)
	}
	if token, exists := b.cursorTokens[*cursor]; exists {
		return &token, nil
	}
	if len(b.cursors) >= maxHistoryContextCursors {
		return nil, errors.New(protocol.HistoryBusy)
	}
	token, err := protocol.NewDispatchID()
	if err != nil {
		return nil, errors.New(protocol.HistoryFailed)
	}
	b.cursors[token], b.cursorTokens[*cursor] = *cursor, token
	return &token, nil
}

func (d *Daemon) preferredHistorySource(sessionID string) string {
	if isTerminalSession(sessionID) {
		return protocol.HistorySourceTerminal
	}
	if d.desktopHistory != nil {
		d.snapshotMu.RLock()
		observation, observed := d.desktopSnapshot[sessionID]
		d.snapshotMu.RUnlock()
		// Initial unavailable placeholders exist for every discovered native ID.
		// Only a previously confirmed owner proves that this is a desktop target.
		if observed && protocol.ValidTurnID(observation.OwnerID) {
			return protocol.HistorySourceDesktop
		}
	}
	return protocol.HistorySourceControl
}

func (d *Daemon) readRoutedHistory(ctx context.Context, msg protocol.ReadHistoryMessage, limit int) (history protocol.SessionHistory, err error) {
	binding, cursor, err := d.historyContexts.acquire(ctx, msg, d.preferredHistorySource(msg.SessionID))
	if err != nil {
		return history, err
	}
	defer func() {
		if err != nil && (msg.HistoryContext == "" || err.Error() == protocol.HistoryContextExpired) {
			d.historyContexts.forget(binding)
		}
		<-binding.gate
	}()
	if err = ctx.Err(); err != nil {
		return history, err
	}
	switch binding.source {
	case protocol.HistorySourceDesktop, protocol.HistorySourceTerminal:
		reader := d.desktopHistory
		if binding.source == protocol.HistorySourceTerminal {
			reader = d.terminalHistory
			available := false
			for _, session := range d.cachedSessions() {
				if session.ID == msg.SessionID && session.HistorySource == protocol.HistorySourceTerminal {
					available = true
					break
				}
			}
			if !available {
				if msg.HistoryContext != "" {
					return history, errors.New(protocol.HistoryContextExpired)
				}
				return history, errors.New(protocol.HistoryUnavailable)
			}
		}
		if reader == nil {
			return history, errors.New(protocol.HistoryUnavailable)
		}
		var generation string
		history, generation, err = reader.ReadHistory(ctx, msg.SessionID, binding.generation, cursor, limit)
		if err != nil {
			return history, err
		}
		if history.Session.ID != msg.SessionID {
			return history, errors.New(protocol.HistoryFailed)
		}
		if !protocol.ValidHistoryIdentity(generation) || (binding.generation != "" && generation != binding.generation) {
			return history, errors.New(protocol.HistoryContextExpired)
		}
		binding.generation = generation
		// File and desktop history never create native loaded/status/send facts.
		found := false
		for _, session := range d.cachedSessions() {
			if session.ID == msg.SessionID {
				history.Session = session
				found = true
				break
			}
		}
		if binding.source == protocol.HistorySourceTerminal && (!found || history.Session.HistorySource != protocol.HistorySourceTerminal) {
			return history, errors.New(protocol.HistoryContextExpired)
		}
	case protocol.HistorySourceControl:
		reader, ok := d.adapter.(codex.HistoryReader)
		if !ok {
			return history, errors.New(protocol.HistoryUnavailable)
		}
		history, err = reader.ReadHistory(ctx, msg.SessionID, cursor, limit)
		if err != nil {
			return history, err
		}
	default:
		return history, errors.New(protocol.HistoryContextExpired)
	}
	if err = ctx.Err(); err != nil {
		return history, err
	}
	if !d.historyContexts.current(binding) {
		return history, errors.New(protocol.HistoryContextExpired)
	}
	if history.Session.ID != msg.SessionID || len(history.Items) > limit {
		return history, errors.New(protocol.HistoryFailed)
	}
	history.NextCursor, err = binding.wrapCursor(history.NextCursor)
	if err != nil {
		return history, err
	}
	history.Source, history.HistoryContext = binding.source, binding.token
	return history, nil
}

func (d *Daemon) resetHistory() {
	d.historyContexts.reset()
	if d.desktopHistory != nil {
		d.desktopHistory.Reset()
	}
	if d.terminalHistory != nil {
		d.terminalHistory.Reset()
	}
}
