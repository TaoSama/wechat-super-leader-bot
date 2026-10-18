package client

import (
	"context"
	"errors"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func (d *Daemon) steerPrompt(ctx context.Context, cmd protocol.ControllerCommandMessage, prompt string) (string, error) {
	if cmd.SendRoute != "" && cmd.SendRoute != protocol.RouteControlSocket && cmd.SendRoute != protocol.RouteAppServerResume {
		return "", errors.New("selected route does not support exact active-turn steering; no input sent")
	}
	sender, ok := d.adapter.(codex.SteerSender)
	if !ok {
		return "", errors.New("configured adapter cannot steer an active turn; no input sent")
	}
	if cmd.SendRoute == protocol.RouteAppServerResume {
		managed, ok := d.adapter.(codex.ResumeSender)
		if !ok || !d.durableJournal || d.journal == nil || d.cfg.SocketPath == "" || managed.Endpoint() != d.cfg.SocketPath {
			return "", errors.New("steer requires the original managed server and durable dispatch identity")
		}
		entry, found, err := d.journal.Lookup(cmd)
		if err != nil || !found || entry.Finished || entry.Dispatch == nil || entry.Dispatch.Route != protocol.RouteAppServerResume {
			return "", errors.New("managed steer durable dispatch claim unavailable; no input sent")
		}
		identity := *entry.Dispatch
		identity.Endpoint = managed.Endpoint()
		if err := d.journal.BindDispatch(cmd, identity); err != nil {
			return "", errors.New("managed steer endpoint could not be persisted; no input sent")
		}
	}
	if cmd.IsExpired() || ctx.Err() != nil {
		return "", errors.New("steer command expired before dispatch; no input sent")
	}
	turnID, err := sender.SteerPrompt(ctx, cmd.SessionID, prompt, cmd.ExpectedTurnID)
	if err != nil {
		return "", err
	}
	if turnID != cmd.ExpectedTurnID {
		return "", &codex.UncertainError{Err: errors.New(protocol.InvalidTurnAcknowledgement)}
	}
	return "turnId=" + turnID, nil
}
