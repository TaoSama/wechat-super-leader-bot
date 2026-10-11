package client

import (
	"context"
	"errors"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/journal"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type desktopController interface {
	CheckSendReadiness(context.Context, string) error
	PrepareSend(context.Context, codex.DesktopSendRequest) (codex.PreparedDesktopSend, error)
	InspectTurn(context.Context, string, string) (codex.TurnObservation, error)
}

// The route is selected before dispatch. Neither an unavailable runtime nor an
// uncertain acknowledgement can cause a second send through another adapter.
func (d *Daemon) sendPrompt(ctx context.Context, cmd protocol.ControllerCommandMessage, prompt string) (string, error) {
	if isTerminalSession(cmd.SessionID) {
		return "", errors.New("terminal sessions are read-only; no input was sent")
	}
	if cmd.SendRoute == protocol.RouteTerminalPane {
		return "", errors.New("terminal-pane cannot target a native session; no fallback was attempted")
	}
	if cmd.SendRoute != protocol.RouteDesktopOwner {
		return d.adapter.SendPrompt(ctx, cmd.SessionID, prompt)
	}
	if !d.cfg.DesktopSend || d.cfg.DesktopSocketPath == "" {
		return "", errors.New("desktop sending is disabled; no input sent")
	}
	if d.desktopController == nil || d.journal == nil {
		return "", errors.New("desktop dispatch requires configured owner transport and durable journal")
	}
	entry, found, err := d.journal.Lookup(cmd)
	if err != nil || !found || entry.Finished || entry.Dispatch == nil {
		return "", &codex.UncertainError{Err: errors.New("desktop dispatch claim unavailable; no input sent")}
	}
	prepared, err := d.desktopController.PrepareSend(ctx, codex.DesktopSendRequest{
		SessionID: cmd.SessionID, ClientUserMessageID: entry.Dispatch.ClientUserMessageID, RequestID: entry.Dispatch.RequestID,
	})
	if err != nil {
		return "", err
	}
	defer prepared.Close()
	identity := prepared.Identity()
	if identity.Endpoint != d.cfg.DesktopSocketPath {
		return "", errors.New("desktop endpoint differs from configured route; no input sent")
	}
	if err := d.journal.BindDispatch(cmd, identity); err != nil {
		return "", &codex.UncertainError{Err: errors.New("desktop dispatch identity could not be persisted; no input sent")}
	}
	if cmd.IsExpired() || ctx.Err() != nil {
		return "", errors.New("desktop command expired before dispatch; no input sent")
	}
	turnID, err := prepared.Dispatch(ctx, prompt)
	if err != nil {
		return "", err
	}
	if !protocol.ValidTurnID(turnID) {
		return "", &codex.UncertainError{Err: errors.New(protocol.InvalidTurnAcknowledgement)}
	}
	return "turnId=" + turnID, nil
}

func (d *Daemon) turnInspector(msg protocol.InspectTurnMessage) (codex.TurnInspector, error) {
	if isTerminalSession(msg.SessionID) {
		return nil, errors.New("terminal turn inspection unavailable; terminal snapshots are not turn receipts")
	}
	if d.journal != nil {
		identity, err := d.journal.ReadDispatch(msg.CommandID, msg.SessionID, msg.TurnID)
		if err == nil {
			if identity.Route != protocol.RouteDesktopOwner || identity.Endpoint != d.cfg.DesktopSocketPath || d.desktopController == nil {
				return nil, errors.New("original desktop route unavailable")
			}
			return d.desktopController, nil
		}
		if !errors.Is(err, journal.ErrNoDispatch) {
			return nil, errors.New("original dispatch identity unavailable")
		}
	}
	inspector, ok := d.adapter.(codex.TurnInspector)
	if !ok {
		return nil, errors.New("adapter does not support turn inspection")
	}
	return inspector, nil
}
