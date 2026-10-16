package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/skills"
)

// ActionType represents supported actions: "read", "send"
type ActionType string

// Controller's daemon WebSocket ingress limit. This is distinct from the
// larger native app-server response limit.
const MaxControllerMessageBytes = 1024 * 1024

const (
	ActionRead ActionType = "read"
	ActionSend ActionType = "send"
	// CapabilityResumeSend is an admission hint, never an executable action.
	CapabilityResumeSend ActionType = "resume-send"
)

// DaemonResultStatus values: completed, failed, accepted, uncertain
type DaemonResultStatus string

const (
	StatusAccepted     DaemonResultStatus = "accepted"
	StatusCompleted    DaemonResultStatus = "completed"
	StatusFailed       DaemonResultStatus = "failed"
	StatusUncertain    DaemonResultStatus = "uncertain"
	StatusInputWritten DaemonResultStatus = "input-written"
)

// Session represents a session discovered on a node
type Session struct {
	ID                 string              `json:"id"`
	Provider           string              `json:"provider"`
	Title              string              `json:"title"`
	Cwd                string              `json:"cwd"`
	Status             string              `json:"status"`
	Capabilities       []ActionType        `json:"capabilities"`
	ObservedAt         string              `json:"observedAt"`
	Model              string              `json:"model,omitempty"`
	ModelProvider      string              `json:"modelProvider,omitempty"`
	ReasoningEffort    string              `json:"reasoningEffort,omitempty"`
	UpdatedAt          string              `json:"updatedAt,omitempty"`
	Preview            string              `json:"preview,omitempty"`
	Loaded             *bool               `json:"loaded,omitempty"`
	DesktopObservation *DesktopObservation `json:"desktopObservation,omitempty"`
	SendAvailability   *SendAvailability   `json:"sendAvailability,omitempty"`
	HistorySource      string              `json:"historySource,omitempty"`
}

// DesktopObservation is read-only telemetry, never authority to send a prompt.
type DesktopObservation struct {
	Status          string `json:"status"`
	ObservedAt      string `json:"observedAt,omitempty"`
	Availability    string `json:"availability"`
	Source          string `json:"source"`
	Model           string `json:"model,omitempty"`
	ModelProvider   string `json:"modelProvider,omitempty"`
	ReasoningEffort string `json:"reasoningEffort,omitempty"`
	// Internal observer proof, never part of public telemetry or send authority.
	OwnerID  string `json:"-"`
	Revision uint64 `json:"-"`
}

// DaemonHelloMessage: {type:"hello",version:1,nodeId:"demoair",sessions:[Session]}
type DaemonHelloMessage struct {
	Type     string         `json:"type"`
	Version  int            `json:"version"`
	NodeID   string         `json:"nodeId"`
	Sessions []Session      `json:"sessions"`
	Skills   []skills.Skill `json:"skills"`
}

// DaemonHeartbeatMessage: {type:"heartbeat",sessions:[Session]}
type DaemonHeartbeatMessage struct {
	Type     string         `json:"type"`
	Sessions []Session      `json:"sessions"`
	Skills   []skills.Skill `json:"skills"`
}

// DaemonResultMessage: {type:"result",commandId,status,output?,error?}
type DaemonResultMessage struct {
	Type      string             `json:"type"`
	CommandID string             `json:"commandId"`
	Status    DaemonResultStatus `json:"status"`
	Output    string             `json:"-"`
	// OutputPresent distinguishes a recorded empty result from no result.
	// Non-empty Output also implies presence for existing string-based callers.
	OutputPresent bool          `json:"-"`
	Error         string        `json:"error,omitempty"`
	TurnID        string        `json:"turnId,omitempty"`
	InputReceipt  *InputReceipt `json:"inputReceipt,omitempty"`
}

// InspectTurnMessage is read-only reconciliation, never a request to start a turn.
type InspectTurnMessage struct {
	Type      string `json:"type"`
	CommandID string `json:"commandId"`
	NodeID    string `json:"nodeId"`
	SessionID string `json:"sessionId"`
	TurnID    string `json:"turnId"`
}

type ResultAckMessage struct {
	Type         string             `json:"type"`
	CommandID    string             `json:"commandId"`
	TurnID       string             `json:"turnId,omitempty"`
	Status       DaemonResultStatus `json:"status"`
	InputReceipt *InputReceipt      `json:"inputReceipt,omitempty"`
}

// ControllerCommandMessage: {type:"command",commandId,nodeId,sessionId,action,prompt?,expiresAt}
type ControllerCommandMessage struct {
	Type      string       `json:"type"`
	CommandID string       `json:"commandId"`
	NodeID    string       `json:"nodeId"`
	SessionID string       `json:"sessionId"`
	Action    ActionType   `json:"action"`
	Prompt    string       `json:"prompt,omitempty"`
	ExpiresAt string       `json:"expiresAt"`
	Skills    []skills.Ref `json:"skills,omitempty"`
	SendRoute SendRoute    `json:"sendRoute,omitempty"`
}

// ParseExpiry parses ExpiresAt in RFC3339Nano or RFC3339 format.
func (c *ControllerCommandMessage) ParseExpiry() (time.Time, error) {
	raw := strings.TrimSpace(c.ExpiresAt)
	if raw == "" {
		return time.Time{}, errors.New("expiresAt is empty")
	}
	t, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		t, err = time.Parse(time.RFC3339, raw)
		if err != nil {
			return time.Time{}, fmt.Errorf("invalid expiresAt %q: %w", raw, err)
		}
	}
	return t, nil
}

// IsExpired checks if a command's expiresAt has passed.
// Fails closed (returns true) if expiresAt is missing or malformed.
func (c *ControllerCommandMessage) IsExpired() bool {
	return c.IsExpiredAt(time.Now().UTC())
}

// IsExpiredAt checks if a command's expiresAt is before or equal to now.
// Fails closed (returns true) if expiresAt is missing or malformed.
func (c *ControllerCommandMessage) IsExpiredAt(now time.Time) bool {
	t, err := c.ParseExpiry()
	if err != nil {
		return true
	}
	return !now.Before(t)
}

// Validate checks required command fields and fails closed on invalid or expired commands.
func (c *ControllerCommandMessage) Validate(expectedNodeID string, now time.Time) error {
	if c.Type != "command" {
		return fmt.Errorf("unexpected message type %q", c.Type)
	}
	if strings.TrimSpace(c.CommandID) == "" {
		return errors.New("commandId is required")
	}
	if strings.TrimSpace(c.NodeID) == "" {
		return errors.New("nodeId is required")
	}
	if c.NodeID != expectedNodeID {
		return fmt.Errorf("nodeId mismatch: command targets %q, daemon is %q", c.NodeID, expectedNodeID)
	}
	if strings.TrimSpace(c.SessionID) == "" {
		return errors.New("sessionId is required")
	}
	if c.Action != ActionRead && c.Action != ActionSend {
		return fmt.Errorf("unsupported action %q", c.Action)
	}
	if c.Action == ActionSend && strings.TrimSpace(c.Prompt) == "" {
		return errors.New("prompt is required for send action")
	}
	if c.SendRoute != "" && (c.Action != ActionSend || (c.SendRoute != RouteControlSocket && c.SendRoute != RouteDesktopOwner && c.SendRoute != RouteTerminalPane && c.SendRoute != RouteAppServerResume)) {
		return errors.New("invalid send route")
	}
	if c.SendRoute == RouteTerminalPane && !strings.HasPrefix(c.SessionID, "terminal:") {
		return errors.New("terminal-pane requires a terminal session")
	}
	if c.SendRoute == RouteAppServerResume && (!ValidHistoryIdentity(c.SessionID) || strings.HasPrefix(c.SessionID, "terminal:")) {
		return errors.New("app-server-resume requires a native session")
	}
	if len(c.Skills) > 0 && c.Action != ActionSend {
		return errors.New("only send accepts skill references")
	}
	if err := skills.ValidateRefs(c.Skills); err != nil {
		return err
	}
	exp, err := c.ParseExpiry()
	if err != nil {
		return err
	}
	if !now.Before(exp) {
		return fmt.Errorf("command expired at %s", exp.UTC().Format(time.RFC3339Nano))
	}
	return nil
}

// PayloadFingerprint returns a stable string representing the payload contents
// to detect duplicate commandIds carrying different parameters.
func (c *ControllerCommandMessage) PayloadFingerprint() string {
	// JSON tuple encoding prevents delimiter collisions between untrusted fields.
	refs := c.Skills
	if refs == nil {
		refs = []skills.Ref{}
	}
	fields := []any{c.NodeID, c.SessionID, c.Action, c.Prompt, c.ExpiresAt, refs}
	if c.SendRoute != "" {
		fields = append(fields, c.SendRoute)
	}
	encoded, err := json.Marshal(fields)
	if err != nil {
		panic(fmt.Sprintf("fixed string-only command tuple cannot be encoded: %v", err))
	}
	return string(encoded)
}
