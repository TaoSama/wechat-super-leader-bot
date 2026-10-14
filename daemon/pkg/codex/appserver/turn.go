package appserver

import (
	"context"
	"errors"
	"fmt"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/internal/threadstate"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

// InspectTurn queries the execution state of an explicitly identified turn via thread/read.
// It never calls thread/resume or turn/start, never mutates session state, and never substitutes
// thread status or other turns for the requested turn.
func (a *AppServerAdapter) InspectTurn(ctx context.Context, sessionID, turnID string) (codex.TurnObservation, error) {
	if !protocol.ValidHistoryIdentity(sessionID) {
		return codex.TurnObservation{}, errors.New("sessionId is invalid")
	}
	if !protocol.ValidTurnID(turnID) {
		return codex.TurnObservation{}, errors.New("turnId is invalid")
	}

	rc, err := a.connect(ctx)
	if err != nil {
		return codex.TurnObservation{}, errors.New("codex connection unavailable")
	}
	defer rc.closeLogged()

	res, err := rc.call(ctx, "thread/read", map[string]any{
		"threadId":     sessionID,
		"includeTurns": true,
	}, a.rpcTimeout)
	if err != nil {
		return codex.TurnObservation{}, errors.New("turn read unavailable")
	}

	threadObj, ok := res["thread"].(map[string]any)
	if !ok {
		return codex.TurnObservation{}, fmt.Errorf("thread/read returned invalid thread object for %s", sessionID)
	}

	// Verify returned thread.id matches sessionID to prevent cross-session mismatch
	if respThreadID, ok := threadObj["id"].(string); !ok || respThreadID != sessionID {
		return codex.TurnObservation{}, errors.New("thread/read response thread ID mismatch")
	}

	rawTurns, _ := threadObj["turns"].([]any)
	if len(rawTurns) == 0 {
		return codex.TurnObservation{}, fmt.Errorf("turn %s not found in session %s (no turns recorded)", turnID, sessionID)
	}

	var targetTurn map[string]any
	for _, raw := range rawTurns {
		turnMap, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		id, _ := turnMap["id"].(string)
		if id == turnID {
			targetTurn = turnMap
			break
		}
	}

	if targetTurn == nil {
		return codex.TurnObservation{}, fmt.Errorf("turn %s not found in session %s", turnID, sessionID)
	}

	rawStatus := threadstate.ExtractStatus(targetTurn["status"])
	normalizedStatus, err := threadstate.NormalizeTurnStatus(rawStatus)
	if err != nil {
		return codex.TurnObservation{}, errors.New("unrecognized turn status")
	}

	output, err := threadstate.ExtractTurnOutput(targetTurn)
	if err != nil {
		return codex.TurnObservation{}, err
	}
	turnErr := threadstate.ExtractTurnError(normalizedStatus)

	return codex.TurnObservation{
		Status: normalizedStatus,
		Output: output,
		Error:  turnErr,
	}, nil
}
