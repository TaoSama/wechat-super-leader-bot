package protocol

import (
	"errors"
	"regexp"
	"strings"
)

// ActionApprove answers one exact pending tool approval with accept or decline.
// It never sends input, never widens policy and never chooses a decision itself.
const ActionApprove ActionType = "approve"

// Approval decisions the controller may forward. Session-wide acceptance and
// policy amendments are deliberately not representable.
const (
	ApprovalAccept  = "accept"
	ApprovalDecline = "decline"
)

// Pending approval kinds reported from native server requests.
const (
	ApprovalKindCommand    = "commandExecution"
	ApprovalKindFileChange = "fileChange"
	ApprovalKindPermission = "permissions"
	ApprovalKindUserInput  = "userInput"
	ApprovalKindOther      = "other"
)

// Bounds for pending approval observations carried in session telemetry.
const (
	MaxPendingApprovals       = 4
	MaxApprovalRequestIDBytes = 128
	MaxApprovalTextRunes      = 600
)

// User-facing reasons shared by validation and execution.
const (
	TerminalApprovalUnsupported = "终端会话暂不支持远程审批"
	DesktopApprovalRequired     = "该审批只能在桌面端处理：请在桌面端处理审批"
)

var approvalRequestIDPattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]+$`)

// PendingApproval is read-only telemetry about one native approval request.
// It is never authority to answer; answering requires an explicit approve command.
type PendingApproval struct {
	RequestID  string `json:"requestId"`
	Kind       string `json:"kind"`
	TurnID     string `json:"turnId,omitempty"`
	ItemID     string `json:"itemId,omitempty"`
	Command    string `json:"command,omitempty"`
	Cwd        string `json:"cwd,omitempty"`
	Reason     string `json:"reason,omitempty"`
	GrantRoot  string `json:"grantRoot,omitempty"`
	StartedAt  string `json:"startedAt,omitempty"`
	Answerable bool   `json:"answerable"`
}

// ValidApprovalRequestID accepts the canonical text form of a JSON-RPC request id.
func ValidApprovalRequestID(id string) bool {
	return id != "" && len(id) <= MaxApprovalRequestIDBytes && approvalRequestIDPattern.MatchString(id)
}

// validateApprove accepts only one exact native turn, request id and decision.
func (c *ControllerCommandMessage) validateApprove() error {
	if strings.HasPrefix(c.SessionID, "terminal:") || c.SendRoute == RouteTerminalPane {
		return errors.New(TerminalApprovalUnsupported)
	}
	if !ValidHistoryIdentity(c.SessionID) || strings.HasPrefix(c.SessionID, ClaudeSessionPrefix) {
		return errors.New("approve requires a native Codex session")
	}
	if !ValidTurnID(c.ExpectedTurnID) {
		return errors.New("approve requires an exact native expectedTurnId")
	}
	if !ValidApprovalRequestID(c.ApprovalRequestID) {
		return errors.New("approve requires an exact approvalRequestId")
	}
	if c.ApprovalDecision != ApprovalAccept && c.ApprovalDecision != ApprovalDecline {
		return errors.New("approve decision must be accept or decline")
	}
	if c.Prompt != "" || len(c.Skills) > 0 || c.DeliveryMode != "" {
		return errors.New("approve carries no prompt, skills or delivery mode")
	}
	switch c.SendRoute {
	case "", RouteControlSocket, RouteDesktopOwner, RouteAppServerResume:
		return nil
	default:
		return errors.New("invalid approve route")
	}
}
