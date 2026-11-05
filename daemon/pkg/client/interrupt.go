package client

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	interruptConfirmInterval = 250 * time.Millisecond
	interruptConfirmTimeout  = 5 * time.Second
	turnStatusInProgress     = "inProgress"
)

type interruptRoute struct {
	interrupter codex.TurnInterrupter
	inspector   codex.TurnInspector
}

// interruptTurn stops one exact running turn on the selected route. It never
// falls back to another route, never resends, and confirms the final status
// with the same route's read-only inspection before reporting completion.
func (d *Daemon) interruptTurn(ctx context.Context, cmd protocol.ControllerCommandMessage) protocol.DaemonResultMessage {
	failed := func(message string) protocol.DaemonResultMessage {
		return protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID, Status: protocol.StatusFailed, Error: message}
	}
	uncertain := func(message string) protocol.DaemonResultMessage {
		return protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID, Status: protocol.StatusUncertain, Error: message}
	}
	if isTerminalSession(cmd.SessionID) || cmd.SendRoute == protocol.RouteTerminalPane {
		return failed(protocol.TerminalInterruptUnsupported)
	}
	route, err := d.selectInterruptRoute(cmd.SendRoute)
	if err != nil {
		return failed(err.Error())
	}
	turn, err := route.inspector.InspectTurn(ctx, cmd.SessionID, cmd.ExpectedTurnID)
	if err != nil {
		return failed("target turn state unavailable; no interrupt sent")
	}
	if turn.Status != turnStatusInProgress {
		return failed(fmt.Sprintf("target turn is not running (status: %s); no interrupt sent", turn.Status))
	}
	if cmd.IsExpired() || ctx.Err() != nil {
		return failed("interrupt command expired before dispatch; no interrupt sent")
	}
	if err := route.interrupter.InterruptTurn(ctx, cmd.SessionID, cmd.ExpectedTurnID); err != nil {
		if codex.IsUncertain(err) || ctx.Err() != nil {
			return uncertain(err.Error())
		}
		return failed(err.Error())
	}
	status, confirmed := confirmTurnStopped(ctx, route.inspector, cmd.SessionID, cmd.ExpectedTurnID)
	if !confirmed {
		return uncertain("interrupt acknowledged but turn stop not yet confirmed; do not retry blindly")
	}
	return protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID, Status: protocol.StatusCompleted,
		TurnID: cmd.ExpectedTurnID, Output: status}
}

func (d *Daemon) selectInterruptRoute(route protocol.SendRoute) (interruptRoute, error) {
	switch route {
	case protocol.RouteDesktopOwner:
		if !d.cfg.DesktopSend || d.cfg.DesktopSocketPath == "" || d.desktopController == nil {
			return interruptRoute{}, errors.New("desktop control is disabled; no interrupt sent")
		}
		interrupter, ok := d.desktopController.(codex.TurnInterrupter)
		if !ok {
			return interruptRoute{}, errors.New("desktop owner transport cannot interrupt turns; no interrupt sent")
		}
		return interruptRoute{interrupter: interrupter, inspector: d.desktopController}, nil
	case "", protocol.RouteControlSocket, protocol.RouteAppServerResume:
		interrupter, interruptOK := d.adapter.(codex.TurnInterrupter)
		inspector, inspectOK := d.adapter.(codex.TurnInspector)
		if !interruptOK || !inspectOK {
			return interruptRoute{}, errors.New("configured adapter cannot interrupt turns; no interrupt sent")
		}
		if route == protocol.RouteAppServerResume {
			managed, ok := d.adapter.(codex.ResumeSender)
			if !ok || d.cfg.SocketPath == "" || managed.Endpoint() != d.cfg.SocketPath {
				return interruptRoute{}, errors.New("interrupt requires the original managed server; no interrupt sent")
			}
		}
		return interruptRoute{interrupter: interrupter, inspector: inspector}, nil
	default:
		return interruptRoute{}, errors.New("unsupported interrupt route; no interrupt sent")
	}
}

// confirmTurnStopped polls the exact turn until it leaves inProgress. Read
// failures are retried until the bounded deadline; they never trigger a resend.
func confirmTurnStopped(ctx context.Context, inspector codex.TurnInspector, sessionID, turnID string) (string, bool) {
	confirmCtx, cancel := context.WithTimeout(ctx, interruptConfirmTimeout)
	defer cancel()
	ticker := time.NewTicker(interruptConfirmInterval)
	defer ticker.Stop()
	for {
		turn, err := inspector.InspectTurn(confirmCtx, sessionID, turnID)
		if err == nil && turn.Status != turnStatusInProgress {
			return turn.Status, true
		}
		select {
		case <-confirmCtx.Done():
			return "", false
		case <-ticker.C:
		}
	}
}
