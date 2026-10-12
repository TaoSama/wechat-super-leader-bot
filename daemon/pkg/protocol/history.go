package protocol

import (
	"errors"
	"strings"
)

const (
	DefaultHistoryLimit      = 30
	MaxHistoryLimit          = 50
	MaxHistoryCursorLength   = 4096
	MaxHistoryIdentityLength = 128
	MaxHistoryResponseBytes  = 1024 * 1024
	MaxHistoryTextLength     = 16000
	HistoryInvalidRequest    = "Invalid history request"
	HistoryUnavailable       = "History API unavailable"
	HistoryFailed            = "History request failed"
	HistoryTimeout           = "History request timed out"
	HistoryBusy              = "Too many history requests"
	HistoryTooLarge          = "History response too large"
	HistoryContextExpired    = "History context expired"
	HistoryIncomplete        = "History incomplete"
	HistorySourceControl     = "control-socket"
	HistorySourceDesktop     = "codex-desktop"
	HistorySourceTerminal    = "terminal-transcript"
)

type ReadHistoryMessage struct {
	Type           string `json:"type"`
	RequestID      string `json:"requestId"`
	NodeID         string `json:"nodeId"`
	SessionID      string `json:"sessionId"`
	Source         string `json:"source,omitempty"`
	Cursor         string `json:"cursor,omitempty"`
	HistoryContext string `json:"historyContext,omitempty"`
	Limit          int    `json:"limit,omitempty"`
}

func (m ReadHistoryMessage) Validate(expectedNodeID string) error {
	if m.Type != "read_history" || m.NodeID != expectedNodeID || !ValidHistoryIdentity(m.RequestID) || !ValidHistoryIdentity(m.SessionID) || len(m.Cursor) > MaxHistoryCursorLength || m.Limit < 0 || m.Limit > MaxHistoryLimit ||
		(m.Source != "" && m.Source != HistorySourceControl) ||
		(m.HistoryContext != "" && !ValidHistoryIdentity(m.HistoryContext)) || (m.Cursor != "" && m.HistoryContext == "") {
		return errors.New(HistoryInvalidRequest)
	}
	return nil
}

type CancelHistoryMessage struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	NodeID    string `json:"nodeId"`
	SessionID string `json:"sessionId"`
}

func ValidHistoryIdentity(value string) bool {
	return value != "" && len(value) <= MaxHistoryIdentityLength && strings.TrimSpace(value) == value && !strings.ContainsAny(value, "\x00\r\n\t ")
}

type DaemonHistoryMessage struct {
	Type      string          `json:"type"`
	RequestID string          `json:"requestId"`
	SessionID string          `json:"sessionId"`
	History   *SessionHistory `json:"history,omitempty"`
	Error     string          `json:"error,omitempty"`
}

type SessionHistory struct {
	HistoryContext string        `json:"historyContext"`
	Source         string        `json:"source"`
	Session        Session       `json:"session"`
	Items          []HistoryItem `json:"items"`
	NextCursor     *string       `json:"nextCursor"`
	FetchedAt      string        `json:"fetchedAt"`
	Truncated      bool          `json:"truncated"`
}

type HistoryItem struct {
	ID        string `json:"id"`
	TurnID    string `json:"turnId"`
	Kind      string `json:"kind"`
	Type      string `json:"type"`
	Text      string `json:"text"`
	Title     string `json:"title,omitempty"`
	Status    string `json:"status,omitempty"`
	Timestamp string `json:"timestamp,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
}
