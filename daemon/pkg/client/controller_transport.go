package client

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	controllerInboundFrameLimit = 8 * 1024 * 1024
	controllerWriteTimeout      = 5 * time.Second
)

var errControllerPayloadLimit = errors.New("controller message exceeds payload limit; nothing was sent")

// Validate the complete wire frame, including merged sources, desktop state,
// skills and envelope. Never silently truncate an inventory or command result.
func encodeControllerMessage(message any) ([]byte, error) {
	limit := protocol.MaxControllerMessageBytes
	var result *protocol.DaemonResultMessage
	switch value := message.(type) {
	case protocol.DaemonResultMessage:
		result = &value
	case *protocol.DaemonResultMessage:
		result = value
	}
	if result != nil && result.Type == "result" {
		if len(result.Output) > protocol.MaxTurnOutputBytes || !utf8.ValidString(result.Output) {
			return nil, errControllerPayloadLimit
		}
		limit = protocol.MaxDaemonResultMessageBytes
	}
	encoded, err := json.Marshal(message)
	if err != nil {
		return nil, errors.New("controller message encoding failed")
	}
	if len(encoded) > limit {
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
	for _, refresh := range []func(context.Context, chan<- struct{}){d.refreshControlSnapshot, d.refreshCatalogSnapshot, d.refreshTerminalSnapshot} {
		pending.Add(1)
		go func() { defer pending.Done(); refresh(ctx, nil) }()
	}
	pending.Wait()
	d.invalidateDesktop(nil)
}
