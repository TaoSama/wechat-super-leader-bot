package client

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const turnInspectionTimeout = 8 * time.Second

func (d *Daemon) handleTrackingMessage(ctx context.Context, kind string, data []byte, send func(any) error) error {
	switch kind {
	case "result_ack":
		var ack protocol.ResultAckMessage
		if err := json.Unmarshal(data, &ack); err != nil {
			return fmt.Errorf("invalid result acknowledgement: %w", err)
		}
		return d.ackResult(ack)
	case "inspect_turn":
		var inspection protocol.InspectTurnMessage
		if err := json.Unmarshal(data, &inspection); err != nil {
			return fmt.Errorf("invalid turn inspection: %w", err)
		}
		// One bounded read at a time per connection; never queues mutation work.
		return send(d.InspectTurn(ctx, inspection))
	case "inspect_command":
		var inspection protocol.InspectCommandMessage
		if err := json.Unmarshal(data, &inspection); err != nil {
			return fmt.Errorf("invalid command inspection: %w", err)
		}
		return send(d.InspectCommand(inspection))
	}
	return nil
}

func parseTurnID(output string) string {
	if !strings.HasPrefix(output, "turnId=") {
		return ""
	}
	id := strings.TrimPrefix(output, "turnId=")
	if !protocol.ValidTurnID(id) {
		return ""
	}
	return id
}

// InspectTurn never sends input and can safely be retried after process restarts.
func (d *Daemon) InspectTurn(ctx context.Context, msg protocol.InspectTurnMessage) protocol.DaemonResultMessage {
	res := protocol.DaemonResultMessage{Type: "result", CommandID: msg.CommandID, TurnID: msg.TurnID, Status: protocol.StatusUncertain}
	if msg.Type != "inspect_turn" || msg.NodeID != d.cfg.NodeID || strings.TrimSpace(msg.CommandID) == "" || strings.TrimSpace(msg.SessionID) == "" || !protocol.ValidTurnID(msg.TurnID) {
		res.Error = "Invalid turn inspection identity"
		return res
	}
	inspector, inspectorErr := d.turnInspector(msg)
	if inspectorErr != nil {
		res.Error = inspectorErr.Error()
		return res
	}
	readCtx, cancel := context.WithTimeout(ctx, turnInspectionTimeout)
	defer cancel()
	turn, err := inspector.InspectTurn(readCtx, msg.SessionID, msg.TurnID)
	if err != nil {
		if errors.Is(err, protocol.ErrTurnOutputLimit) || errors.Is(err, protocol.ErrTurnObservationLimit) {
			res.Status = protocol.StatusFailed
			res.Error = protocol.ErrTurnOutputLimit.Error()
			if errors.Is(err, protocol.ErrTurnObservationLimit) {
				res.Error = protocol.ErrTurnObservationLimit.Error()
			}
			return d.persistInspectedTurn(msg.SessionID, res)
		}
		res.Error = "Turn observation unavailable; execution state is unconfirmed"
		return res
	}
	switch turn.Status {
	case "inProgress":
		res.Status = protocol.StatusAccepted
	case "completed":
		res.Status = protocol.StatusCompleted
	case "failed", "interrupted":
		res.Status = protocol.StatusFailed
		res.Error = "Turn " + turn.Status
	default:
		res.Error = "Unknown turn status; execution state is unconfirmed"
		return res
	}
	res.Output = turn.Output
	res.OutputPresent = turn.Status == "completed" && turn.Output == ""
	return d.persistInspectedTurn(msg.SessionID, completeResultReceipt(res))
}

func (d *Daemon) persistInspectedTurn(sessionID string, res protocol.DaemonResultMessage) protocol.DaemonResultMessage {
	if d.journal == nil || (res.Status != protocol.StatusCompleted && res.Status != protocol.StatusFailed) {
		return res
	}
	if err := d.journal.RecordTurnResult(sessionID, res); err != nil {
		failure := journalFailure(res.CommandID)
		failure.TurnID = res.TurnID
		return failure
	}
	return res
}

// InspectCommand only looks up the exact original payload. Expired commands
// remain inspectable; missing receipts never trigger adapter work or replay.
func (d *Daemon) InspectCommand(msg protocol.InspectCommandMessage) protocol.DaemonResultMessage {
	res := protocol.DaemonResultMessage{Type: "result", CommandID: msg.CommandID, Status: protocol.StatusUncertain}
	if msg.Type != "inspect_command" || msg.NodeID != d.cfg.NodeID || msg.CommandID == "" || len(msg.CommandID) > 128 || msg.CommandID != strings.TrimSpace(msg.CommandID) || strings.TrimSpace(msg.SessionID) == "" {
		res.Error = "Invalid command inspection identity"
		return res
	}
	msg.Type = "command"
	if d.journal != nil {
		entry, found, err := d.journal.Lookup(msg)
		if err != nil {
			return journalFailure(msg.CommandID)
		}
		if found {
			return entry.Result
		}
	}
	res.Error = "Original command receipt unavailable; execution is unconfirmed, do not replay"
	return res
}

// The in-memory fixture path queues receipts here. Production receipts are
// persisted by ExecuteCommand and replayed from the journal until acknowledged.
func (d *Daemon) queueResult(res protocol.DaemonResultMessage) {
	if d.journal != nil {
		return
	}
	d.outboxMu.Lock()
	defer d.outboxMu.Unlock()
	d.outbox[res.CommandID] = res
}

func (d *Daemon) reserveResult(commandID string) bool {
	if d.journal != nil {
		return true
	} // The durable Begin transaction enforces capacity.
	d.outboxMu.Lock()
	defer d.outboxMu.Unlock()
	if _, exists := d.outbox[commandID]; !exists {
		if len(d.outbox) >= MaxDedupeEntries {
			return false
		}
		d.outbox[commandID] = protocol.DaemonResultMessage{}
	}
	return true
}

func (d *Daemon) ackResult(ack protocol.ResultAckMessage) error {
	if d.journal != nil {
		return d.journal.Ack(ack)
	}
	d.outboxMu.Lock()
	defer d.outboxMu.Unlock()
	res, exists := d.outbox[ack.CommandID]
	if exists && res.Type == "result" && protocol.ReceiptMatchesAck(res, ack) {
		delete(d.outbox, ack.CommandID)
	}
	return nil
}

func (d *Daemon) flushResults(send func(any) error) error {
	if d.journal != nil {
		return d.flushJournal(send)
	}
	d.outboxMu.Lock()
	results := make([]protocol.DaemonResultMessage, 0, len(d.outbox))
	for _, res := range d.outbox {
		if res.Type == "result" {
			results = append(results, res)
		}
	}
	d.outboxMu.Unlock()
	for _, res := range results {
		if err := send(res); err != nil {
			return fmt.Errorf("result replay failed: %w", err)
		}
	}
	return nil
}
