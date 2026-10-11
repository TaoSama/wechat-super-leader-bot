package terminal

import (
	"errors"
	"strings"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

// ValidateDeliveryIdentity verifies a private durable binding, not authority to
// dispatch. Only the original prepared object can perform a fresh preflight.
func ValidateDeliveryIdentity(identity DeliveryIdentity) error {
	if ValidateSelectors(identity.Endpoint, []string{identity.PaneID}) != nil ||
		!protocol.ValidInputRequestID(identity.RequestID) || identity.Revision > protocol.MaxSafeRevision {
		return errors.New("invalid terminal delivery identity")
	}
	for _, field := range []string{identity.TerminalID, identity.WorkspaceID, identity.TabID, identity.Provider,
		identity.AgentSessionSource, identity.AgentSessionAgent, identity.AgentSessionValue} {
		if !validIdentity(field) {
			return errors.New("invalid terminal delivery identity")
		}
	}
	if identity.Provider != "terminal/"+identity.AgentSessionAgent || (identity.AgentSessionKind != "id" && identity.AgentSessionKind != "path") {
		return errors.New("invalid terminal delivery identity")
	}
	bound := binding{Pane: identity.PaneID, Terminal: identity.TerminalID, Workspace: identity.WorkspaceID, Tab: identity.TabID,
		Provider: identity.Provider, Session: &agentSession{Source: identity.AgentSessionSource, Agent: identity.AgentSessionAgent,
			Kind: identity.AgentSessionKind, Value: identity.AgentSessionValue}}
	id, err := (&Observer{socket: identity.Endpoint}).publicID(bound)
	if err != nil || id != identity.SessionID || len(identity.PromptSHA256) != 64 || strings.Trim(identity.PromptSHA256, "0123456789abcdef") != "" {
		return errors.New("invalid terminal delivery identity")
	}
	return nil
}
