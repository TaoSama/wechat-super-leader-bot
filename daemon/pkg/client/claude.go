package client

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/claude"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const claudeRefreshInterval = 15 * time.Second
const claudeDiscoveryTimeout = 12 * time.Second

func isClaudeSession(id string) bool { return claude.IsSession(id) }

func (d *Daemon) configureClaude() {
	settings, enabled := d.cfg.ClaudeAdapterConfig()
	if !enabled {
		return
	}
	adapter, err := claude.New(settings)
	if err != nil {
		log.Printf("Claude Code sessions disabled: %v", err)
		return
	}
	d.claude = adapter
}

// Claude discovery has its own worker, so a slow CLI query never delays
// Codex observation, heartbeats or command handling.
func (d *Daemon) refreshClaude(ctx context.Context, updates chan<- struct{}) {
	if d.claude == nil {
		return
	}
	ticker := time.NewTicker(claudeRefreshInterval)
	defer ticker.Stop()
	for ctx.Err() == nil {
		d.refreshClaudeSnapshot(ctx, updates)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (d *Daemon) refreshClaudeSnapshot(ctx context.Context, updates chan<- struct{}) {
	readCtx, cancel := context.WithTimeout(ctx, claudeDiscoveryTimeout)
	sessions, err := d.claude.DiscoverSessions(readCtx)
	cancel()
	if ctx.Err() != nil {
		return
	}
	if err != nil {
		log.Printf("[daemon:%s] Claude Code session discovery unavailable; retaining last observed snapshot", d.cfg.NodeID)
		return
	}
	d.snapshotMu.Lock()
	changed := sessionsChanged(d.claudeSnapshot, sessions)
	d.claudeSnapshot = cloneSessions(sessions)
	d.snapshotMu.Unlock()
	if changed {
		signalSnapshotUpdate(updates)
	}
}

// Caller holds snapshotMu. Without a durable journal no Claude send can be
// bound to an exact turn, so the inventory stays read-only.
func (d *Daemon) claudeSessionsLocked() []protocol.Session {
	sessions := cloneSessions(d.claudeSnapshot)
	for i := range sessions {
		// A launched turn is busy at once, not only after the next file scan.
		if d.claude != nil && d.claude.Running(sessions[i].ID) {
			sessions[i].Status = claude.StatusActive
		}
		if !d.durableJournal || d.journal == nil {
			sessions[i].Capabilities = []protocol.ActionType{protocol.ActionRead}
		}
	}
	return sessions
}

// sendClaude binds the durable dispatch identity before starting the CLI. The
// journal request ID becomes the exact turn ID used by later inspection.
func (d *Daemon) sendClaude(ctx context.Context, cmd protocol.ControllerCommandMessage, prompt string) (string, error) {
	if d.claude == nil || !d.durableJournal || d.journal == nil {
		return "", errors.New("Claude Code sending is disabled or lacks a durable journal; no input sent")
	}
	entry, found, err := d.journal.Lookup(cmd)
	if err != nil || !found || entry.Finished || entry.Dispatch == nil || entry.Dispatch.Route != protocol.RouteClaudeResume {
		return "", &codex.UncertainError{Err: errors.New("claude-resume durable dispatch claim unavailable; no input sent")}
	}
	identity := *entry.Dispatch
	identity.Endpoint = d.claude.Endpoint()
	if err := d.journal.BindDispatch(cmd, identity); err != nil {
		return "", &codex.UncertainError{Err: errors.New("claude-resume endpoint could not be persisted; no input sent")}
	}
	if cmd.IsExpired() || ctx.Err() != nil {
		return "", errors.New("claude-resume command expired before launch; no input sent")
	}
	if err := d.claude.Send(ctx, cmd.SessionID, identity.RequestID, prompt); err != nil {
		return "", err
	}
	return "turnId=" + identity.RequestID, nil
}

// watchClaudeTurn records the final receipt once the accepted run ends, using
// the same exact inspection path the Controller uses for reconciliation.
func (d *Daemon) watchClaudeTurn(cmd protocol.ControllerCommandMessage, res protocol.DaemonResultMessage) {
	if d.claude == nil || res.Status != protocol.StatusAccepted || cmd.SendRoute != protocol.RouteClaudeResume {
		return
	}
	done, ok := d.claude.Done(res.TurnID)
	if !ok {
		return
	}
	d.claudeWatchers.Add(1)
	go func() {
		defer d.claudeWatchers.Done()
		<-done
		inspection := protocol.InspectTurnMessage{Type: "inspect_turn", CommandID: cmd.CommandID, NodeID: d.cfg.NodeID,
			SessionID: cmd.SessionID, TurnID: res.TurnID}
		if final := d.InspectTurn(context.Background(), inspection); final.Status == protocol.StatusUncertain {
			log.Printf("[daemon:%s] Claude Code turn ended without a confirmed outcome", d.cfg.NodeID)
		}
	}()
}

func (d *Daemon) closeClaude() {
	if d.claude == nil {
		return
	}
	d.claude.Close()
	d.claudeWatchers.Wait()
}
