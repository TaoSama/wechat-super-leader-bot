package appserver

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/internal/threadstate"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	methodCommandApproval    = "item/commandExecution/requestApproval"
	methodFileChangeApproval = "item/fileChange/requestApproval"
	methodPermissionApproval = "item/permissions/requestApproval"
	methodUserInput          = "item/tool/requestUserInput"
	methodRequestResolved    = "serverRequest/resolved"
	commandKindCommand       = "command"
	serverEventBuffer        = 64
)

// serverEvent is one server-initiated request (ID set) or notification.
type serverEvent struct {
	Method string
	ID     json.RawMessage
	Params json.RawMessage
}

// forwardServerEvent hands a server message to an observing caller. It never
// blocks the read loop: a full buffer drops the event, which callers treat as
// missing evidence rather than as an answer.
func (rc *rpcConn) forwardServerEvent(data []byte) {
	if rc.serverEvents == nil {
		return
	}
	var event struct {
		Method string          `json:"method"`
		ID     json.RawMessage `json:"id"`
		Params json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(data, &event); err != nil || event.Method == "" {
		return
	}
	if string(event.ID) == "null" {
		event.ID = nil
	}
	select {
	case rc.serverEvents <- serverEvent{Method: event.Method, ID: event.ID, Params: event.Params}:
	default:
	}
}

// canonicalRequestID renders a JSON-RPC id (string or integer) as stable text.
func canonicalRequestID(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return text, protocol.ValidApprovalRequestID(text)
	}
	var number json.Number
	if err := json.Unmarshal(raw, &number); err != nil {
		return "", false
	}
	if _, err := strconv.ParseInt(number.String(), 10, 64); err != nil {
		return "", false
	}
	return number.String(), true
}

type approvalParams struct {
	Kind              string   `json:"kind"`
	ThreadID          string   `json:"threadId"`
	TurnID            string   `json:"turnId"`
	ItemID            string   `json:"itemId"`
	StartedAtMs       *float64 `json:"startedAtMs"`
	Reason            *string  `json:"reason"`
	Command           *string  `json:"command"`
	Cwd               *string  `json:"cwd"`
	GrantRoot         *string  `json:"grantRoot"`
	AvailableDecision []any    `json:"availableDecisions"`
}

// pendingApprovalFrom summarizes a replayed request for the target thread.
// Unknown or other-thread requests return false and are never reported.
func pendingApprovalFrom(event serverEvent, sessionID string) (protocol.PendingApproval, approvalParams, bool) {
	var params approvalParams
	id, ok := canonicalRequestID(event.ID)
	if !ok || json.Unmarshal(event.Params, &params) != nil || params.ThreadID != sessionID {
		return protocol.PendingApproval{}, params, false
	}
	approval := protocol.PendingApproval{RequestID: id, ItemID: cleanText(params.ItemID, protocol.MaxHistoryIdentityLength)}
	if protocol.ValidTurnID(params.TurnID) {
		approval.TurnID = params.TurnID
	}
	switch event.Method {
	case methodCommandApproval:
		approval.Kind = protocol.ApprovalKindCommand
		approval.Command = cleanOptional(params.Command)
		approval.Cwd = cleanOptional(params.Cwd)
		// Only an ordinary command prompt is answered remotely; stdin prompts stay local.
		approval.Answerable = params.Kind == "" || params.Kind == commandKindCommand
	case methodFileChangeApproval:
		approval.Kind = protocol.ApprovalKindFileChange
		approval.GrantRoot = cleanOptional(params.GrantRoot)
		approval.Answerable = true
	case methodPermissionApproval:
		approval.Kind = protocol.ApprovalKindPermission
	case methodUserInput:
		approval.Kind = protocol.ApprovalKindUserInput
	default:
		return protocol.PendingApproval{}, params, false
	}
	approval.Reason = cleanOptional(params.Reason)
	if params.StartedAtMs != nil {
		approval.StartedAt = threadstate.NativeTimestamp(*params.StartedAtMs, true)
	}
	approval.Answerable = approval.Answerable && approval.TurnID != "" && decisionOffered(params.AvailableDecision)
	return approval, params, true
}

// decisionOffered requires accept and decline when the server restricts choices.
func decisionOffered(available []any) bool {
	if available == nil {
		return true
	}
	accept, decline := false, false
	for _, choice := range available {
		accept = accept || choice == protocol.ApprovalAccept
		decline = decline || choice == protocol.ApprovalDecline
	}
	return accept && decline
}

func cleanOptional(value *string) string {
	if value == nil {
		return ""
	}
	return cleanText(*value, 0)
}

// cleanText removes control characters and bounds displayed native text.
func cleanText(value string, maxBytes int) string {
	cleaned := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == '\u2028' || r == '\u2029' {
			return ' '
		}
		return r
	}, value)
	cleaned = threadstate.TruncateText(strings.TrimSpace(cleaned), protocol.MaxApprovalTextRunes)
	if maxBytes > 0 {
		cleaned = threadstate.ClipHistoryText(cleaned, maxBytes)
	}
	return cleaned
}

// resolvedRequestID extracts the request id of a serverRequest/resolved notification for sessionID.
func resolvedRequestID(event serverEvent, sessionID string) (string, bool) {
	if event.Method != methodRequestResolved || event.ID != nil {
		return "", false
	}
	var params struct {
		ThreadID  string          `json:"threadId"`
		RequestID json.RawMessage `json:"requestId"`
	}
	if json.Unmarshal(event.Params, &params) != nil || params.ThreadID != sessionID {
		return "", false
	}
	return canonicalRequestID(params.RequestID)
}

// errResponseNotWritten means the connection closed before any response byte was written.
var errResponseNotWritten = errors.New("codex connection closed before the approval response was written")

// respond writes one JSON-RPC response to a server request, echoing its exact id.
func (rc *rpcConn) respond(id json.RawMessage, result map[string]any) error {
	msg := map[string]any{"jsonrpc": "2.0", "id": id, "result": result}
	rc.writeMu.Lock()
	defer rc.writeMu.Unlock()
	select {
	case <-rc.done:
		return errResponseNotWritten
	default:
	}
	if err := rc.conn.SetWriteDeadline(time.Now().Add(DefaultWriteTimeout)); err != nil {
		return fmt.Errorf("set response write deadline: %w", err)
	}
	return rc.conn.WriteJSON(msg)
}
