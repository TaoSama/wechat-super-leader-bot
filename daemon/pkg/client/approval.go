package client

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	sessionStatusWaitingApproval = "waitingApproval"
	// approvalProbeInterval bounds how often one waiting thread is re-subscribed.
	approvalProbeInterval = 10 * time.Second
	approvalProbeTimeout  = 3 * time.Second
	// maxApprovalProbesPerRefresh bounds extra connections per discovery cycle.
	maxApprovalProbesPerRefresh = 2
	approvalResolvedOutput      = "resolved"
	approvalUnreachableMessage  = "审批请求在当前控制通道不可达，未提交决定"
)

type approvalProbe struct {
	approvals []protocol.PendingApproval
	probedAt  time.Time
	updatedAt string
}

// approvalCache holds the last observed pending approvals per waiting session.
type approvalCache struct {
	mu     sync.Mutex
	probes map[string]approvalProbe
}

func (c *approvalCache) invalidate(sessionID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.probes, sessionID)
}

// attachPendingApprovals observes pending approvals for loaded waiting sessions.
// It only subscribes and reads replayed requests; it never answers them.
func (d *Daemon) attachPendingApprovals(ctx context.Context, sessions []protocol.Session) {
	reader, ok := d.adapter.(codex.ApprovalReader)
	if !ok {
		return
	}
	d.approvals.mu.Lock()
	defer d.approvals.mu.Unlock()
	if d.approvals.probes == nil {
		d.approvals.probes = map[string]approvalProbe{}
	}
	waiting := map[string]bool{}
	probes := 0
	now := time.Now()
	for i := range sessions {
		session := &sessions[i]
		if session.Status != sessionStatusWaitingApproval || session.Loaded == nil || !*session.Loaded {
			continue
		}
		waiting[session.ID] = true
		cached, found := d.approvals.probes[session.ID]
		fresh := found && now.Sub(cached.probedAt) < approvalProbeInterval && cached.updatedAt == session.UpdatedAt
		if !fresh && probes < maxApprovalProbesPerRefresh {
			probes++
			probeCtx, cancel := context.WithTimeout(ctx, approvalProbeTimeout)
			approvals, err := reader.PendingApprovals(probeCtx, session.ID)
			cancel()
			if err != nil {
				log.Printf("[daemon:%s] pending approval observation unavailable", d.cfg.NodeID)
				approvals = nil
			}
			cached = approvalProbe{approvals: approvals, probedAt: now, updatedAt: session.UpdatedAt}
			d.approvals.probes[session.ID] = cached
		}
		session.PendingApprovals = append([]protocol.PendingApproval(nil), cached.approvals...)
	}
	for id := range d.approvals.probes {
		if !waiting[id] {
			delete(d.approvals.probes, id)
		}
	}
}

// answerApproval forwards one explicit accept/decline for an exact pending
// request. It never chooses a decision, never falls back to another route and
// never retries; resolution is confirmed by the same server.
func (d *Daemon) answerApproval(ctx context.Context, cmd protocol.ControllerCommandMessage) protocol.DaemonResultMessage {
	failed := func(message string) protocol.DaemonResultMessage {
		return protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID, Status: protocol.StatusFailed, Error: message}
	}
	if isTerminalSession(cmd.SessionID) || cmd.SendRoute == protocol.RouteTerminalPane {
		return failed(protocol.TerminalApprovalUnsupported)
	}
	if isClaudeSession(cmd.SessionID) {
		return failed("Claude Code sessions do not support remote approval")
	}
	answerer, ok := d.adapter.(codex.ApprovalAnswerer)
	if !ok {
		if cmd.SendRoute == protocol.RouteDesktopOwner {
			return failed(protocol.DesktopApprovalRequired)
		}
		return failed("configured adapter cannot answer approvals; no decision sent")
	}
	if cmd.SendRoute == protocol.RouteAppServerResume {
		managed, ok := d.adapter.(codex.ResumeSender)
		if !ok || d.cfg.SocketPath == "" || managed.Endpoint() != d.cfg.SocketPath {
			return failed("approval requires the original managed server; no decision sent")
		}
	}
	if cmd.IsExpired() || ctx.Err() != nil {
		return failed("approve command expired before dispatch; no decision sent")
	}
	defer d.approvals.invalidate(cmd.SessionID)
	err := answerer.AnswerApproval(ctx, cmd.SessionID, cmd.ExpectedTurnID, cmd.ApprovalRequestID, cmd.ApprovalDecision)
	switch {
	case err == nil:
		return protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID, Status: protocol.StatusCompleted,
			TurnID: cmd.ExpectedTurnID, Output: approvalResolvedOutput}
	case codex.IsUncertain(err):
		return protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID, Status: protocol.StatusUncertain, Error: err.Error()}
	case errors.Is(err, codex.ErrApprovalUnreachable):
		if cmd.SendRoute == protocol.RouteDesktopOwner {
			return failed(protocol.DesktopApprovalRequired)
		}
		return failed(approvalUnreachableMessage)
	default:
		return failed(err.Error())
	}
}
