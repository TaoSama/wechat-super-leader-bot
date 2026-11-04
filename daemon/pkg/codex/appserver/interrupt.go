package appserver

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

var _ codex.TurnInterrupter = (*AppServerAdapter)(nil)

// InterruptTurn asks the live server to stop the exact turn. It never resumes
// an unloaded thread or starts a turn; the caller confirms the final status.
func (a *AppServerAdapter) InterruptTurn(ctx context.Context, sessionID, turnID string) error {
	if !protocol.ValidHistoryIdentity(sessionID) || strings.HasPrefix(sessionID, "terminal:") || !protocol.ValidTurnID(turnID) {
		return errors.New("invalid interrupt target identity")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	rc, err := a.connect(ctx)
	if err != nil {
		return err
	}
	defer rc.closeLogged()
	loaded, err := rc.getLoadedSet(ctx, a.rpcTimeout)
	if err != nil {
		return err
	}
	if !loaded[sessionID] {
		return errors.New("interrupt target is not loaded; no interrupt sent")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, err := rc.call(ctx, "turn/interrupt", map[string]any{"threadId": sessionID, "turnId": turnID}, a.rpcTimeout); err != nil {
		if errors.Is(err, errInvalidRPCResponse) {
			return &codex.UncertainError{Err: errors.New("turn/interrupt acknowledgement invalid")}
		}
		var rejected *rpcRejectedError
		if errors.As(err, &rejected) {
			return fmt.Errorf("turn/interrupt rejected: %w", err)
		}
		return &codex.UncertainError{Err: fmt.Errorf("turn/interrupt acknowledgement uncertain: %w", err)}
	}
	return nil
}
