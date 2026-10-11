package terminal

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/transcript"
)

// HistoryReader uses the observer's frozen public identity, not a requested
// native path or identifier. It performs no terminal input or pane snapshot RPC.
type HistoryReader struct {
	observer *Observer
	reader   *transcript.Reader
	mu       sync.Mutex
	epoch    uint64
}

func NewHistoryReader(observer *Observer, reader *transcript.Reader) *HistoryReader {
	return &HistoryReader{observer: observer, reader: reader}
}

func historyRef(bound binding) (transcript.Ref, bool) {
	if bound.Session == nil || bound.Provider != "terminal/"+bound.Session.Agent {
		return transcript.Ref{}, false
	}
	session := bound.Session
	return transcript.Ref{Source: session.Source, Agent: session.Agent, Kind: session.Kind, Value: session.Value}, true
}

func (h *HistoryReader) Supports(publicID string) bool {
	if h == nil || h.observer == nil || h.reader == nil || !sessionPattern.MatchString(publicID) {
		return false
	}
	h.observer.mu.Lock()
	bound, exists := h.observer.bindings[publicID]
	h.observer.mu.Unlock()
	ref, valid := historyRef(bound)
	return exists && valid && h.reader.Supports(ref)
}

func (h *HistoryReader) Reset() {
	if h != nil && h.reader != nil {
		h.mu.Lock()
		h.epoch++
		h.reader.Reset()
		h.mu.Unlock()
	}
}

func historyError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return context.DeadlineExceeded
	}
	return errors.New(protocol.HistoryUnavailable)
}

func (h *HistoryReader) ReadHistory(ctx context.Context, publicID, generation, cursor string, limit int) (history protocol.SessionHistory, nextGeneration string, err error) {
	if h == nil || h.observer == nil || h.reader == nil || !sessionPattern.MatchString(publicID) {
		return history, "", errors.New(protocol.HistoryUnavailable)
	}
	o := h.observer
	h.mu.Lock()
	epoch := h.epoch
	h.mu.Unlock()
	if err := o.validate(); err != nil {
		return history, "", errors.New(protocol.HistoryUnavailable)
	}
	o.mu.Lock()
	known, exists := o.bindings[publicID]
	o.mu.Unlock()
	if !exists {
		return history, "", errors.New(protocol.HistoryContextExpired)
	}
	ref, valid := historyRef(known)
	if !valid || !h.reader.Supports(ref) {
		return history, "", errors.New(protocol.HistoryUnavailable)
	}
	ctx, cancel := context.WithTimeout(ctx, o.operationTimeout)
	defer cancel()
	c, err := o.connect(ctx)
	if err != nil {
		return history, "", historyError(ctx, err)
	}
	defer func() {
		if closeErr := c.close(); closeErr != nil {
			history = protocol.SessionHistory{}
			nextGeneration = ""
			err = errors.Join(err, errors.New(protocol.HistoryFailed))
		}
	}()
	before, err := c.getAgent(known.Pane)
	if err != nil {
		return history, "", historyError(ctx, err)
	}
	if before == nil || !sameBinding(known, before.binding()) {
		return history, "", errors.New(protocol.HistoryContextExpired)
	}
	page, nextGeneration, err := h.reader.Read(ctx, ref, generation, cursor, limit)
	if err != nil {
		return history, "", err
	}
	after, err := c.getAgent(known.Pane)
	if err != nil {
		return history, "", historyError(ctx, err)
	}
	if after == nil || !sameBinding(known, after.binding()) || *after.Revision < *before.Revision {
		return history, "", errors.New(protocol.HistoryContextExpired)
	}
	// Discovery may have been refreshed while disk I/O was in progress. A
	// revoked binding must not publish history even when its socket still agrees.
	o.mu.Lock()
	current, exists := o.bindings[publicID]
	o.mu.Unlock()
	if !exists || !sameBinding(known, current) {
		return history, "", errors.New(protocol.HistoryContextExpired)
	}
	if err := ctx.Err(); err != nil {
		return history, "", err
	}
	h.mu.Lock()
	validEpoch := epoch == h.epoch
	h.mu.Unlock()
	if !validEpoch {
		return history, "", errors.New(protocol.HistoryContextExpired)
	}
	loaded := false
	history = protocol.SessionHistory{
		Source: protocol.HistorySourceTerminal,
		Session: protocol.Session{ID: publicID, Provider: known.Provider, Title: after.publicTitle(), Cwd: after.publicCwd(), Status: observedStatus(after.Status),
			Capabilities: []protocol.ActionType{protocol.ActionRead}, Loaded: &loaded, ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), HistorySource: protocol.HistorySourceTerminal},
		Items: page.Items, NextCursor: page.NextCursor, Truncated: page.Truncated, FetchedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
	return history, nextGeneration, nil
}
