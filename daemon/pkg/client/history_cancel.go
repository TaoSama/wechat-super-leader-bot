package client

import (
	"context"
	"encoding/json"
	"sync"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type historyRequestKey struct{ requestID, nodeID, sessionID string }
type historyCancellation struct{ cancel context.CancelFunc }
type historyRequests struct {
	mu      sync.Mutex
	pending map[historyRequestKey]*historyCancellation
}

func newHistoryRequests() *historyRequests {
	return &historyRequests{pending: make(map[historyRequestKey]*historyCancellation)}
}

func (h *historyRequests) register(ctx context.Context, msg protocol.ReadHistoryMessage) (context.Context, func(), bool) {
	key := historyRequestKey{msg.RequestID, msg.NodeID, msg.SessionID}
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, exists := h.pending[key]; exists {
		return nil, nil, false
	}
	requestCtx, cancel := context.WithCancel(ctx)
	entry := &historyCancellation{cancel: cancel}
	h.pending[key] = entry
	return requestCtx, func() {
		cancel()
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.pending[key] == entry {
			delete(h.pending, key)
		}
	}, true
}

func (d *Daemon) cancelHistory(data []byte) {
	var msg protocol.CancelHistoryMessage
	if json.Unmarshal(data, &msg) != nil || msg.Type != "cancel_history" || msg.NodeID != d.cfg.NodeID ||
		!protocol.ValidHistoryIdentity(msg.RequestID) || !protocol.ValidHistoryIdentity(msg.SessionID) {
		return
	}
	d.historyRequests.mu.Lock()
	defer d.historyRequests.mu.Unlock()
	if entry := d.historyRequests.pending[historyRequestKey{msg.RequestID, msg.NodeID, msg.SessionID}]; entry != nil {
		entry.cancel()
	}
}
