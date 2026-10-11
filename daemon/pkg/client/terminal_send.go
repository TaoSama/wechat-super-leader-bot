package client

import (
	"context"
	"errors"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/terminal"
)

func terminalFailure(commandID, reason string, uncertain bool) protocol.DaemonResultMessage {
	status := protocol.StatusFailed
	if uncertain {
		status = protocol.StatusUncertain
	}
	return protocol.DaemonResultMessage{Type: "result", CommandID: commandID, Status: status, Error: reason}
}

// sendTerminal shares the existing command claim/result journal. Preparation is
// read-only, BindTerminal is durable, and only the same object may then Dispatch.
func (d *Daemon) sendTerminal(ctx context.Context, cmd protocol.ControllerCommandMessage) (res protocol.DaemonResultMessage) {
	if cmd.SendRoute != protocol.RouteTerminalPane || d.cfg.TerminalSendMode != protocol.TerminalNonAtomicMode || d.terminalController == nil {
		return terminalFailure(cmd.CommandID, "terminal sessions are read-only unless explicitly configured for non-atomic terminal-pane delivery; no input sent", false)
	}
	if !d.durableJournal || d.journal == nil {
		return terminalFailure(cmd.CommandID, "terminal input requires a durable command journal; no input sent", false)
	}
	entry, found, err := d.journal.Lookup(cmd)
	if err != nil || !found || entry.Finished || entry.TerminalDelivery == nil {
		return terminalFailure(cmd.CommandID, "terminal dispatch claim unavailable; no input sent", false)
	}
	prompt, err := d.prepareSkillPrompt(cmd)
	if err != nil {
		return terminalFailure(cmd.CommandID, "terminal skill selection is unavailable or changed; no input sent", false)
	}
	if ctx.Err() != nil || cmd.IsExpired() {
		return terminalFailure(cmd.CommandID, "terminal command expired or canceled before preparation; no input sent", false)
	}
	prepared, err := d.terminalController.PrepareDelivery(ctx, cmd.SessionID, entry.TerminalDelivery.RequestID, prompt)
	if err != nil {
		return terminalFailure(cmd.CommandID, "terminal target preparation failed; no input sent", false)
	}
	defer func() {
		if closeErr := prepared.Close(); closeErr != nil {
			var deliveryErr *terminal.DeliveryError
			uncertain := res.Status == protocol.StatusInputWritten || res.Status == protocol.StatusUncertain ||
				(errors.As(closeErr, &deliveryErr) && deliveryErr.Uncertain)
			res = terminalFailure(cmd.CommandID, "terminal delivery cleanup failed; execution is unconfirmed", uncertain)
		}
	}()
	identity := prepared.Identity()
	if identity.Endpoint != d.cfg.TerminalSocketPath || ctx.Err() != nil || cmd.IsExpired() {
		return terminalFailure(cmd.CommandID, "terminal command expired or target changed after preparation; no input sent", false)
	}
	if err := d.journal.BindTerminal(cmd, identity); err != nil {
		return terminalFailure(cmd.CommandID, "terminal target identity could not be persisted; no input sent", false)
	}
	if ctx.Err() != nil || cmd.IsExpired() {
		return terminalFailure(cmd.CommandID, "terminal command expired or canceled before dispatch; no input sent", false)
	}
	receipt, err := prepared.Dispatch(ctx)
	if err != nil {
		var deliveryErr *terminal.DeliveryError
		uncertain := !errors.As(err, &deliveryErr) || deliveryErr.Uncertain || deliveryErr.Attempted
		return terminalFailure(cmd.CommandID, "terminal input delivery failed or lacks complete evidence; do not automatically resend", uncertain)
	}
	proof := &protocol.InputReceipt{Kind: receipt.Kind, SessionID: receipt.SessionID, RequestID: receipt.RequestID,
		PromptSHA256: receipt.PromptSHA256, ResponseRevision: receipt.ResponseRevision, ObservedRevision: receipt.ObservedRevision}
	if proof.Validate() != nil {
		return terminalFailure(cmd.CommandID, "terminal input receipt cannot be represented safely; do not automatically resend", true)
	}
	return protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID, Status: protocol.StatusInputWritten, InputReceipt: proof}
}
