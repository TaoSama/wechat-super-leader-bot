package appserver

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net"
	"os"
	"syscall"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/internal/threadstate"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func (a *AppServerAdapter) mediaGeneration() (string, error) {
	info, err := os.Stat(a.socketPath)
	if err != nil || info.Mode()&os.ModeSocket == 0 {
		return "", errors.New(protocol.MediaContextExpired)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", errors.New(protocol.MediaUnavailable)
	}
	return fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("%d:%d:%d", stat.Dev, stat.Ino, info.ModTime().UnixNano())))), nil
}

func (a *AppServerAdapter) ValidateMediaGeneration(ctx context.Context, sessionID, generation string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	current, err := a.mediaGeneration()
	if err != nil || current != generation {
		return errors.New(protocol.MediaContextExpired)
	}
	dialer := net.Dialer{Timeout: a.dialTimeout}
	connection, err := dialer.DialContext(ctx, "unix", a.socketPath)
	if err != nil {
		return errors.New(protocol.MediaContextExpired)
	}
	if err := connection.Close(); err != nil {
		return errors.New(protocol.MediaFailed)
	}
	current, err = a.mediaGeneration()
	if err != nil || current != generation {
		return errors.New(protocol.MediaContextExpired)
	}
	return nil
}

// ListSessionMedia reads only an existing thread's bounded newest native items.
func (a *AppServerAdapter) ListSessionMedia(ctx context.Context, sessionID, generation, itemID, turnID string, limit int) ([]protocol.NativeMediaReference, string, error) {
	current, err := a.mediaGeneration()
	if err != nil {
		return nil, "", err
	}
	if generation != "" && generation != current {
		return nil, "", errors.New(protocol.MediaContextExpired)
	}
	rc, err := a.connect(ctx)
	if err != nil {
		return nil, "", errors.New(protocol.MediaUnavailable)
	}
	defer rc.closeLogged()
	metadata, err := rc.call(ctx, "thread/read", map[string]any{"threadId": sessionID, "includeTurns": false}, a.rpcTimeout)
	if err != nil {
		return nil, "", errors.New(protocol.MediaUnavailable)
	}
	thread, ok := metadata["thread"].(map[string]any)
	if !ok || threadstate.ExtractString(thread, "id") != sessionID {
		return nil, "", errors.New(protocol.MediaFailed)
	}
	page, err := rc.call(ctx, "thread/items/list", map[string]any{"threadId": sessionID, "sortDirection": "desc", "limit": protocol.MaxHistoryLimit}, a.rpcTimeout)
	if err != nil {
		return nil, "", errors.New(protocol.MediaUnavailable)
	}
	items, ok := page["data"].([]any)
	if !ok || len(items) > protocol.MaxHistoryLimit {
		return nil, "", errors.New(protocol.MediaFailed)
	}
	refs := []protocol.NativeMediaReference{}
	for _, value := range items {
		wrapper, ok := value.(map[string]any)
		if !ok {
			continue
		}
		for _, ref := range threadstate.ItemMedia(wrapper) {
			if itemID != "" && ref.ItemID != itemID || turnID != "" && ref.TurnID != turnID {
				continue
			}
			refs = append(refs, ref)
			if len(refs) >= limit {
				break
			}
		}
		if len(refs) > 0 {
			break
		}
	}
	if err := a.ValidateMediaGeneration(ctx, sessionID, current); err != nil {
		return nil, "", err
	}
	return refs, current, nil
}
