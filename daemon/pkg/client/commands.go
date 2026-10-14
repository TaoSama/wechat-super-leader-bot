package client

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

// ExecuteCommand validates, deduplicates, serializes per-session mutations, and runs the requested action.
func (d *Daemon) executeVolatileCommand(ctx context.Context, cmd protocol.ControllerCommandMessage) protocol.DaemonResultMessage {
	cmdID := strings.TrimSpace(cmd.CommandID)
	fingerprint := cmd.PayloadFingerprint()

	// 1. Check deduplication cache
	if cached, found := d.checkDedupe(cmdID); found && cmdID != "" {
		if cached.fingerprint != fingerprint {
			return protocol.DaemonResultMessage{
				Type:      "result",
				CommandID: cmdID,
				Status:    protocol.StatusFailed,
				Output:    "",
				Error:     fmt.Sprintf("duplicate commandId %q carries conflicting payload parameters", cmdID),
			}
		}
		return cached.result
	}

	// 2. Validate exact node identity, required fields, and command expiry (fails closed)
	if err := cmd.Validate(d.cfg.NodeID, time.Now().UTC()); err != nil {
		res := protocol.DaemonResultMessage{
			Type:      "result",
			CommandID: cmdID,
			Status:    protocol.StatusFailed,
			Output:    "",
			Error:     err.Error(),
		}
		if cmdID != "" {
			d.recordDedupe(res, fingerprint)
		}
		return res
	}

	// 3. Prevent concurrent in-flight execution of the same commandId across sessions
	d.inFlightMu.Lock()
	waitCh, inFlight := d.inFlight[cmdID]
	if inFlight {
		d.inFlightMu.Unlock()
		// Wait for the earlier in-flight execution to finish
		select {
		case <-waitCh:
		case <-ctx.Done():
			return protocol.DaemonResultMessage{
				Type:      "result",
				CommandID: cmdID,
				Status:    protocol.StatusUncertain,
				Output:    "",
				Error:     "context canceled while waiting for in-flight duplicate command",
			}
		}
		if cached, found := d.checkDedupe(cmdID); found {
			if cached.fingerprint != fingerprint {
				return protocol.DaemonResultMessage{
					Type:      "result",
					CommandID: cmdID,
					Status:    protocol.StatusFailed,
					Output:    "",
					Error:     fmt.Sprintf("duplicate commandId %q carries conflicting payload parameters", cmdID),
				}
			}
			return cached.result
		}
	} else {
		notifyCh := make(chan struct{})
		d.inFlight[cmdID] = notifyCh
		d.inFlightMu.Unlock()
		defer func() {
			d.inFlightMu.Lock()
			delete(d.inFlight, cmdID)
			close(notifyCh)
			d.inFlightMu.Unlock()
		}()
	}

	// 4. Serialize operations per sessionId so concurrent requests never race on the same session
	sessionMu := d.getSessionLock(cmd.SessionID)
	sessionMu.Lock()
	defer sessionMu.Unlock()

	// Re-check deduplication after acquiring session lock
	if cached, found := d.checkDedupe(cmdID); found {
		if cached.fingerprint != fingerprint {
			return protocol.DaemonResultMessage{
				Type:      "result",
				CommandID: cmdID,
				Status:    protocol.StatusFailed,
				Output:    "",
				Error:     fmt.Sprintf("duplicate commandId %q carries conflicting payload parameters", cmdID),
			}
		}
		return cached.result
	}

	// Re-check expiry after waiting on session lock
	if cmd.IsExpired() {
		res := protocol.DaemonResultMessage{
			Type:      "result",
			CommandID: cmdID,
			Status:    protocol.StatusFailed,
			Output:    "",
			Error:     "command expired while waiting for session lock",
		}
		d.recordDedupe(res, fingerprint)
		return res
	}

	expiresAt, err := cmd.ParseExpiry()
	if err != nil {
		res := protocol.DaemonResultMessage{Type: "result", CommandID: cmdID, Status: protocol.StatusFailed, Error: err.Error()}
		d.recordDedupe(res, fingerprint)
		return res
	}
	execDeadline := time.Now().Add(CommandExecTimeout)
	if expiresAt.Before(execDeadline) {
		execDeadline = expiresAt
	}
	// WithDeadline also preserves an earlier parent deadline. Native preflight
	// and the mutation write must share the command's remaining lifetime.
	execCtx, cancel := context.WithDeadline(ctx, execDeadline)
	defer cancel()

	var res protocol.DaemonResultMessage
	switch cmd.Action {
	case protocol.ActionRead:
		output, err := d.readSession(execCtx, cmd.SessionID)
		if err != nil {
			if execCtx.Err() != nil {
				// Execution context timed out or was canceled
				res = protocol.DaemonResultMessage{
					Type:      "result",
					CommandID: cmdID,
					Status:    protocol.StatusFailed,
					Output:    "",
					Error:     fmt.Sprintf("read session timed out: %v", err),
				}
			} else {
				res = protocol.DaemonResultMessage{
					Type:      "result",
					CommandID: cmdID,
					Status:    protocol.StatusFailed,
					Output:    "",
					Error:     err.Error(),
				}
			}
		} else {
			res = protocol.DaemonResultMessage{
				Type:          "result",
				CommandID:     cmdID,
				Status:        protocol.StatusCompleted,
				Output:        output,
				OutputPresent: output == "",
			}
		}

	case protocol.ActionSend:
		if isTerminalSession(cmd.SessionID) {
			res = d.sendTerminal(execCtx, cmd)
			break
		}
		prompt, prepareErr := d.prepareSkillPrompt(cmd)
		if prepareErr != nil {
			res = protocol.DaemonResultMessage{Type: "result", CommandID: cmdID, Status: protocol.StatusFailed, Error: prepareErr.Error()}
			break
		}
		if cmd.IsExpired() || execCtx.Err() != nil {
			res = protocol.DaemonResultMessage{Type: "result", CommandID: cmdID, Status: protocol.StatusFailed, Error: "command expired before skill task dispatch"}
			break
		}
		ackOutput, err := d.sendPrompt(execCtx, cmd, prompt)
		if err != nil {
			if codex.IsUncertain(err) || execCtx.Err() != nil {
				// Turn dispatch is uncertain (turn may have started on server)
				res = protocol.DaemonResultMessage{
					Type:      "result",
					CommandID: cmdID,
					Status:    protocol.StatusUncertain,
					Output:    "",
					Error:     err.Error(),
				}
			} else {
				// Definite pre-flight rejection (not loaded, not idle, invalid params)
				res = protocol.DaemonResultMessage{
					Type:      "result",
					CommandID: cmdID,
					Status:    protocol.StatusFailed,
					Output:    "",
					Error:     err.Error(),
				}
			}
		} else if turnID := parseTurnID(ackOutput); turnID != "" {
			// Contract: send RPC returns accepted with turn id, not fabricated completed output
			res = protocol.DaemonResultMessage{
				Type:      "result",
				CommandID: cmdID,
				Status:    protocol.StatusAccepted,
				Output:    ackOutput,
				TurnID:    turnID,
			}
		} else {
			res = protocol.DaemonResultMessage{Type: "result", CommandID: cmdID, Status: protocol.StatusUncertain, Error: protocol.InvalidTurnAcknowledgement}
		}

	default:
		res = protocol.DaemonResultMessage{
			Type:      "result",
			CommandID: cmdID,
			Status:    protocol.StatusFailed,
			Output:    "",
			Error:     fmt.Sprintf("unsupported action %q", cmd.Action),
		}
	}

	d.recordDedupe(res, fingerprint)
	return res
}
