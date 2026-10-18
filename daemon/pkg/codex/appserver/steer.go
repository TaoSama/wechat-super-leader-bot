package appserver

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

var _ codex.SteerSender = (*AppServerAdapter)(nil)

// SteerPrompt delegates the active-turn comparison to the native atomic
// expectedTurnId check. An unavailable turn is never replaced by turn/start.
func (a *AppServerAdapter) SteerPrompt(ctx context.Context, sessionID, prompt, expectedTurnID string) (string, error) {
	if !protocol.ValidHistoryIdentity(sessionID) || strings.HasPrefix(sessionID, "terminal:") || !protocol.ValidTurnID(expectedTurnID) {
		return "", errors.New("invalid steer target identity")
	}
	if !utf8.ValidString(prompt) || strings.TrimSpace(prompt) == "" || len(prompt) > protocol.MaxControllerMessageBytes {
		return "", errors.New("invalid steer prompt")
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	rc, err := a.connect(ctx)
	if err != nil {
		return "", err
	}
	defer rc.closeLogged()
	loaded, err := rc.getLoadedSet(ctx, a.rpcTimeout)
	if err != nil {
		return "", err
	}
	if !loaded[sessionID] {
		return "", errors.New("steer target is not loaded; no input sent")
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	result, err := rc.call(ctx, "turn/steer", map[string]any{
		"threadId": sessionID, "expectedTurnId": expectedTurnID,
		"input": []map[string]any{{"type": "text", "text": prompt}},
	}, a.rpcTimeout)
	if err != nil {
		if errors.Is(err, errInvalidRPCResponse) {
			return "", &codex.UncertainError{Err: errors.New(protocol.InvalidTurnAcknowledgement)}
		}
		var rejected *rpcRejectedError
		if errors.As(err, &rejected) {
			return "", fmt.Errorf("turn/steer rejected: %w", err)
		}
		return "", &codex.UncertainError{Err: fmt.Errorf("turn/steer acknowledgement uncertain: %w", err)}
	}
	turnID, _ := result["turnId"].(string)
	if turnID != expectedTurnID {
		return "", &codex.UncertainError{Err: errors.New(protocol.InvalidTurnAcknowledgement)}
	}
	return turnID, nil
}
