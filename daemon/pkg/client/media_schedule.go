package client

import (
	"context"
	"encoding/json"
	"sync"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func (d *Daemon) scheduleMediaRead(ctx context.Context, data []byte, slots chan struct{}, workers *sync.WaitGroup, send func(any) error, failures chan<- error) error {
	var header struct {
		Type      string `json:"type"`
		RequestID string `json:"requestId"`
		NodeID    string `json:"nodeId"`
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(data, &header); err != nil {
		return send(protocol.DaemonMediaListMessage{Type: "media_list", Error: protocol.MediaInvalidRequest})
	}
	var operation func(context.Context) any
	var busy any
	switch header.Type {
	case "list_media":
		var request protocol.ListMediaMessage
		if err := json.Unmarshal(data, &request); err != nil {
			return send(protocol.DaemonMediaListMessage{Type: "media_list", Error: protocol.MediaInvalidRequest})
		}
		if err := request.Validate(d.cfg.NodeID); err != nil {
			return send(d.ListMedia(ctx, request))
		}
		operation = func(ctx context.Context) any { return d.ListMedia(ctx, request) }
		busy = protocol.DaemonMediaListMessage{Type: "media_list", RequestID: request.RequestID, SessionID: request.SessionID, Error: protocol.MediaBusy}
	case "read_media":
		var request protocol.ReadMediaMessage
		if err := json.Unmarshal(data, &request); err != nil {
			return send(protocol.DaemonMediaChunkMessage{Type: "media_chunk", Error: protocol.MediaInvalidRequest})
		}
		if err := request.Validate(d.cfg.NodeID); err != nil {
			return send(d.ReadMedia(ctx, request))
		}
		operation = func(ctx context.Context) any { return d.ReadMedia(ctx, request) }
		busy = protocol.DaemonMediaChunkMessage{Type: "media_chunk", RequestID: request.RequestID, SessionID: request.SessionID, MediaContext: request.MediaContext, MediaID: request.MediaID, Error: protocol.MediaBusy}
	default:
		return nil
	}
	select {
	case slots <- struct{}{}:
		requestCtx, cleanup, registered := d.historyRequests.register(ctx, protocol.ReadHistoryMessage{RequestID: header.RequestID, NodeID: header.NodeID, SessionID: header.SessionID})
		if !registered {
			<-slots
			return send(busy)
		}
		workers.Add(1)
		go func() {
			defer workers.Done()
			defer cleanup()
			defer func() { <-slots }()
			response := operation(requestCtx)
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
		return send(busy)
	}
}

func (d *Daemon) cancelMedia(data []byte) {
	var msg protocol.CancelHistoryMessage
	if err := json.Unmarshal(data, &msg); err != nil || msg.Type != "cancel_media" || msg.NodeID != d.cfg.NodeID || !protocol.ValidHistoryIdentity(msg.RequestID) || !protocol.ValidHistoryIdentity(msg.SessionID) {
		return
	}
	d.historyRequests.mu.Lock()
	defer d.historyRequests.mu.Unlock()
	if entry := d.historyRequests.pending[historyRequestKey{msg.RequestID, msg.NodeID, msg.SessionID}]; entry != nil {
		entry.cancel()
	}
}
