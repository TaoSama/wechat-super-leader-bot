package client

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const historyReadTimeout = 8 * time.Second
const maxConcurrentHistoryReads = 4

func (d *Daemon) scheduleHistoryRead(ctx context.Context, data []byte, slots chan struct{}, workers *sync.WaitGroup, send func(any) error, failures chan<- error) error {
	var request protocol.ReadHistoryMessage
	if err := json.Unmarshal(data, &request); err != nil {
		return send(protocol.DaemonHistoryMessage{Type: "history", Error: protocol.HistoryInvalidRequest})
	}
	if err := request.Validate(d.cfg.NodeID); err != nil {
		return send(d.ReadHistory(ctx, request))
	}
	select {
	case slots <- struct{}{}:
		requestCtx, cleanup, registered := d.historyRequests.register(ctx, request)
		if !registered {
			<-slots
			return send(protocol.DaemonHistoryMessage{Type: "history", RequestID: request.RequestID, SessionID: request.SessionID, Error: protocol.HistoryInvalidRequest})
		}
		workers.Add(1)
		go func() {
			defer workers.Done()
			defer func() { <-slots }()
			defer cleanup()
			response := d.ReadHistory(requestCtx, request)
			if requestCtx.Err() != nil {
				return
			}
			if err := send(response); err != nil {
				select {
				case failures <- err:
				case <-ctx.Done():
				}
			}
		}()
		return nil
	default:
		return send(protocol.DaemonHistoryMessage{Type: "history", RequestID: request.RequestID, SessionID: request.SessionID, Error: protocol.HistoryBusy})
	}
}

// ReadHistory is ephemeral; it does not reserve or record a command receipt.
func (d *Daemon) ReadHistory(ctx context.Context, msg protocol.ReadHistoryMessage) protocol.DaemonHistoryMessage {
	response := protocol.DaemonHistoryMessage{Type: "history", RequestID: msg.RequestID, SessionID: msg.SessionID}
	if err := msg.Validate(d.cfg.NodeID); err != nil {
		if !protocol.ValidHistoryIdentity(response.RequestID) {
			response.RequestID = ""
		}
		if !protocol.ValidHistoryIdentity(response.SessionID) {
			response.SessionID = ""
		}
		response.Error = protocol.HistoryInvalidRequest
		return response
	}
	limit := msg.Limit
	if isTerminalSession(msg.SessionID) {
		response.Error = protocol.HistoryUnavailable
		return response
	}
	if limit == 0 {
		limit = protocol.DefaultHistoryLimit
	}
	readCtx, cancel := context.WithTimeout(ctx, historyReadTimeout)
	defer cancel()
	history, err := d.readRoutedHistory(readCtx, msg, limit)
	if readCtx.Err() != nil {
		response.Error = protocol.HistoryTimeout
		return response
	}
	if err != nil {
		response.Error = protocol.HistoryFailed
		if errors.Is(err, context.DeadlineExceeded) {
			response.Error = protocol.HistoryTimeout
		}
		switch err.Error() {
		case protocol.HistoryUnavailable, protocol.HistoryTimeout, protocol.HistoryTooLarge, protocol.HistoryContextExpired, protocol.HistoryIncomplete, protocol.HistoryBusy:
			response.Error = err.Error()
		}
		return response
	}
	if history.Session.ID != msg.SessionID || len(history.Items) > limit || history.NextCursor != nil && len(*history.NextCursor) > protocol.MaxHistoryCursorLength {
		response.Error = protocol.HistoryFailed
		return response
	}
	response.History = &history
	encoded, err := json.Marshal(response)
	if err != nil || len(encoded) >= protocol.MaxHistoryResponseBytes {
		response.History, response.Error = nil, protocol.HistoryTooLarge
	}
	return response
}
