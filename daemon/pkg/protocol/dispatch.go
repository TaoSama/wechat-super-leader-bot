package protocol

import (
	"crypto/rand"
	"fmt"
)

// SendRoute identifies the selected runtime. Dispatch must never fall back to
// another route after a mutation request may have been transmitted.
type SendRoute string

const (
	RouteControlSocket   SendRoute = "control-socket"
	RouteDesktopOwner    SendRoute = "desktop-owner"
	RouteTerminalPane    SendRoute = "terminal-pane"
	RouteAppServerResume SendRoute = "app-server-resume"
)

// DispatchIdentity binds a durable command to its runtime endpoint. Desktop
// dispatches also bind the owner and connection. Request identifiers are local
// correlation, not native deduplication.
type DispatchIdentity struct {
	Route               SendRoute `json:"route"`
	SessionID           string    `json:"sessionId"`
	ClientUserMessageID string    `json:"clientUserMessageId"`
	RequestID           string    `json:"requestId"`
	OwnerID             string    `json:"ownerId,omitempty"`
	ConnectionID        string    `json:"connectionId,omitempty"`
	Endpoint            string    `json:"endpoint,omitempty"`
}

// NewDispatchID produces a UUID before the journal claim is committed.
func NewDispatchID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", fmt.Errorf("generate dispatch identity: %w", err)
	}
	value[6], value[8] = value[6]&15|64, value[8]&63|128
	return fmt.Sprintf("%x-%x-%x-%x-%x", value[:4], value[4:6], value[6:8], value[8:10], value[10:]), nil
}
