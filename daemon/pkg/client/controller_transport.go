package client

import (
	"context"
	"encoding/json"
	"errors"
	"sync"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

var errControllerPayloadLimit = errors.New("controller message exceeds payload limit; nothing was sent")

// Validate the complete wire frame, including merged sources, desktop state,
// skills and envelope. Never silently truncate an inventory or command result.
func encodeControllerMessage(message any) ([]byte, error) {
	encoded, err := json.Marshal(message)
	if err != nil {
		return nil, errors.New("controller message encoding failed")
	}
	if len(encoded) > protocol.MaxControllerMessageBytes {
		return nil, errControllerPayloadLimit
	}
	return encoded, nil
}

// A cached oversized hello fails before the connection workers can start.
// Refresh after those workers have joined so shrinking sources can recover
// without restarting the process or sending a truncated/empty inventory.
func (d *Daemon) recoverControllerPayload(ctx context.Context, cause error) {
	if !errors.Is(cause, errControllerPayloadLimit) || ctx.Err() != nil {
		return
	}
	var pending sync.WaitGroup
	for _, refresh := range []func(context.Context, chan<- struct{}){d.refreshControlSnapshot, d.refreshCatalogSnapshot} {
		pending.Add(1)
		go func() { defer pending.Done(); refresh(ctx, nil) }()
	}
	pending.Wait()
	d.invalidateDesktop(nil)
}
