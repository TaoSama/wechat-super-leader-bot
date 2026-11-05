package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	desktopInterruptVersion  = 4
	desktopInterruptUserStop = "user-stop"
)

var _ codex.TurnInterrupter = (*DesktopController)(nil)

// InterruptTurn asks the existing owner to stop exactly turnID. The owner
// compares expectedTurnId itself; no other turn can be stopped by this request.
func (d *DesktopController) InterruptTurn(ctx context.Context, sessionID, turnID string) error {
	if !protocol.ValidHistoryIdentity(sessionID) || !protocol.ValidTurnID(turnID) {
		return errors.New("invalid desktop interrupt target identity")
	}
	requestID, err := protocol.NewDispatchID()
	if err != nil {
		return err
	}
	p, err := d.prepareConnection(ctx, sessionID)
	if err != nil {
		return err
	}
	defer p.Close()
	stop := context.AfterFunc(ctx, p.Close)
	defer stop()
	response, writeAttempted, err := p.targeted(ctx, desktopInterruptTurn, desktopInterruptVersion, requestID, map[string]any{
		"conversationId": sessionID, "mode": desktopInterruptUserStop, "expectedTurnId": turnID,
	})
	if err != nil {
		if !writeAttempted {
			return err
		}
		return &codex.UncertainError{Err: fmt.Errorf("desktop interrupt acknowledgement uncertain: %w", err)}
	}
	var result struct {
		InterruptedTurnID *string `json:"interruptedTurnId"`
		OK                *bool   `json:"ok"`
	}
	if err := json.Unmarshal(response.Result, &result); err != nil || result.OK == nil {
		return &codex.UncertainError{Err: errors.New("desktop interrupt acknowledgement invalid")}
	}
	if !*result.OK {
		return errors.New("desktop owner did not interrupt the expected turn")
	}
	if result.InterruptedTurnID == nil || *result.InterruptedTurnID != turnID {
		return &codex.UncertainError{Err: errors.New("desktop interrupt acknowledged a different turn")}
	}
	return nil
}
