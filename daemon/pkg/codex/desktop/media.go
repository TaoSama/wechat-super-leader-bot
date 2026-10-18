package desktop

import (
	"context"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/internal/threadstate"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func (r *DesktopHistoryReader) ValidateMediaGeneration(ctx context.Context, sessionID, generation string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	entry := r.entries[sessionID]
	if entry == nil || entry.generation != generation {
		return historyError(protocol.MediaContextExpired)
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if entry.err != nil || entry.ctx.Err() != nil {
		return historyError(protocol.MediaContextExpired)
	}
	return nil
}

func (r *DesktopHistoryReader) ListSessionMedia(ctx context.Context, sessionID, generation, itemID, turnID string, limit int) ([]protocol.NativeMediaReference, string, error) {
	_, current, err := r.ReadHistory(ctx, sessionID, generation, "", 1)
	if err != nil {
		return nil, "", err
	}
	r.mu.Lock()
	entry := r.entries[sessionID]
	if entry == nil || entry.generation != current {
		r.mu.Unlock()
		return nil, "", historyError(protocol.MediaContextExpired)
	}
	entry.mu.Lock()
	r.mu.Unlock()
	if entry.err != nil || entry.ctx.Err() != nil {
		entry.mu.Unlock()
		return nil, "", historyError(protocol.MediaContextExpired)
	}
	raw := append([]byte(nil), entry.raw...)
	entry.mu.Unlock()
	state, err := decodeDesktopHistoryState(raw)
	if err != nil {
		return nil, "", err
	}
	turns, complete, _, err := historyChosenTurns(state)
	if err != nil {
		return nil, "", err
	}
	if !complete {
		return nil, "", historyError(protocol.HistoryIncomplete)
	}
	refs := []protocol.NativeMediaReference{}
collect:
	for i := len(turns) - 1; i >= 0; i-- {
		if err := ctx.Err(); err != nil {
			return nil, "", err
		}
		turn, ok := turns[i].(map[string]any)
		if !ok {
			return nil, "", historyError(protocol.MediaFailed)
		}
		items, _ := turn["items"].([]any)
		for j := len(items) - 1; j >= 0; j-- {
			item, ok := items[j].(map[string]any)
			if !ok {
				continue
			}
			for _, ref := range threadstate.ItemMedia(map[string]any{"item": item, "turnId": turn["turnId"]}) {
				if itemID != "" && ref.ItemID != itemID || turnID != "" && ref.TurnID != turnID {
					continue
				}
				refs = append(refs, ref)
				if len(refs) >= limit {
					break collect
				}
			}
			if len(refs) > 0 {
				break collect
			}
		}
	}
	if err := r.ValidateMediaGeneration(ctx, sessionID, current); err != nil {
		return nil, "", err
	}
	return refs, current, nil
}
