package codex

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

// TurnObservation records the observed state and output of an explicitly identified turn.
type TurnObservation struct {
	Status string
	Output string
	Error  string
}

// TurnInspector is an optional interface implemented by adapters that support
// querying the execution state of an explicitly identified turn.
type TurnInspector interface {
	InspectTurn(ctx context.Context, sessionID, turnID string) (TurnObservation, error)
}

// InspectTurn queries the execution state of an explicitly identified turn via thread/read.
// It never calls thread/resume or turn/start, never mutates session state, and never substitutes
// thread status or other turns for the requested turn.
func (a *AppServerAdapter) InspectTurn(ctx context.Context, sessionID, turnID string) (TurnObservation, error) {
	if !protocol.ValidHistoryIdentity(sessionID) {
		return TurnObservation{}, errors.New("sessionId is invalid")
	}
	if !protocol.ValidTurnID(turnID) {
		return TurnObservation{}, errors.New("turnId is invalid")
	}

	rc, err := a.connect(ctx)
	if err != nil {
		return TurnObservation{}, errors.New("codex connection unavailable")
	}
	defer rc.closeLogged()

	res, err := rc.call(ctx, "thread/read", map[string]any{
		"threadId":     sessionID,
		"includeTurns": true,
	}, a.rpcTimeout)
	if err != nil {
		return TurnObservation{}, errors.New("turn read unavailable")
	}

	threadObj, ok := res["thread"].(map[string]any)
	if !ok {
		return TurnObservation{}, fmt.Errorf("thread/read returned invalid thread object for %s", sessionID)
	}

	// Verify returned thread.id matches sessionID to prevent cross-session mismatch
	if respThreadID, ok := threadObj["id"].(string); !ok || respThreadID != sessionID {
		return TurnObservation{}, errors.New("thread/read response thread ID mismatch")
	}

	rawTurns, _ := threadObj["turns"].([]any)
	if len(rawTurns) == 0 {
		return TurnObservation{}, fmt.Errorf("turn %s not found in session %s (no turns recorded)", turnID, sessionID)
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
		return TurnObservation{}, fmt.Errorf("turn %s not found in session %s", turnID, sessionID)
	}

	rawStatus := extractStatus(targetTurn["status"])
	normalizedStatus, err := normalizeTurnStatus(rawStatus)
	if err != nil {
		return TurnObservation{}, errors.New("unrecognized turn status")
	}

	output := extractTurnOutput(targetTurn)
	turnErr := extractTurnError(normalizedStatus)

	return TurnObservation{
		Status: normalizedStatus,
		Output: output,
		Error:  turnErr,
	}, nil
}

// normalizeTurnStatus maps raw status strictly to exactly: inProgress, completed, failed, interrupted.
// No arbitrary aliases like success/done/error are accepted.
func normalizeTurnStatus(raw string) (string, error) {
	switch strings.TrimSpace(raw) {
	case "inProgress":
		return "inProgress", nil
	case "completed":
		return "completed", nil
	case "failed":
		return "failed", nil
	case "interrupted":
		return "interrupted", nil
	default:
		return "", errors.New("unrecognized turn status")
	}
}

func extractTurnOutput(turnMap map[string]any) string {
	items, _ := turnMap["items"].([]any)
	var agentOutputs []string

	for _, rawItem := range items {
		item, ok := rawItem.(map[string]any)
		if !ok {
			continue
		}
		itemType, _ := item["type"].(string)
		if itemType == "agentMessage" {
			text, _ := item["text"].(string)
			text = strings.TrimSpace(text)
			if text != "" {
				agentOutputs = append(agentOutputs, text)
			}
		}
	}

	if len(agentOutputs) == 0 {
		return ""
	}

	combined := strings.Join(agentOutputs, "\n\n")
	return truncateText(combined, MaxReadLineLength)
}

// extractTurnError provides static sanitized error descriptions without leaking upstream error payloads or keys.
func extractTurnError(normalizedStatus string) string {
	switch normalizedStatus {
	case "failed":
		return "turn failed"
	case "interrupted":
		return "turn interrupted"
	default:
		return ""
	}
}
