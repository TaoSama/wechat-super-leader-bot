package protocol

import (
	"errors"
	"strings"
)

// TerminalInterruptUnsupported is the user-facing reason terminal panes cannot be interrupted.
const TerminalInterruptUnsupported = "终端会话暂不支持中断"

// validateInterrupt accepts only an exact native turn on a native session route.
func (c *ControllerCommandMessage) validateInterrupt() error {
	if strings.HasPrefix(c.SessionID, "terminal:") || c.SendRoute == RouteTerminalPane {
		return errors.New(TerminalInterruptUnsupported)
	}
	if !ValidHistoryIdentity(c.SessionID) {
		return errors.New("interrupt requires a native session")
	}
	if !ValidTurnID(c.ExpectedTurnID) {
		return errors.New("interrupt requires an exact native expectedTurnId")
	}
	if c.Prompt != "" || len(c.Skills) > 0 || c.DeliveryMode != "" {
		return errors.New("interrupt carries no prompt, skills or delivery mode")
	}
	switch c.SendRoute {
	case "", RouteControlSocket, RouteDesktopOwner, RouteAppServerResume:
		return nil
	default:
		return errors.New("invalid interrupt route")
	}
}
