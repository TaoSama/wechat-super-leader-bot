package client

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type approvalAdapter struct {
	receiptAdapter
	endpoint string
	err      error
	answers  atomic.Int32
	probes   atomic.Int32
	pending  []protocol.PendingApproval
}

func (a *approvalAdapter) Endpoint() string { return a.endpoint }
func (a *approvalAdapter) ResumeSend(context.Context, string, string) (string, error) {
	return "", errors.New("approval attempted resume mutation")
}
func (a *approvalAdapter) AnswerApproval(_ context.Context, sessionID, turnID, requestID, decision string) error {
	a.answers.Add(1)
	if sessionID != "fixture-session" || turnID != "turn-1" || requestID != "7" || decision != protocol.ApprovalAccept {
		return errors.New("inexact approval target")
	}
	return a.err
}
func (a *approvalAdapter) PendingApprovals(context.Context, string) ([]protocol.PendingApproval, error) {
	a.probes.Add(1)
	return a.pending, nil
}

func approveCommand(id string, route protocol.SendRoute) protocol.ControllerCommandMessage {
	return protocol.ControllerCommandMessage{Type: "command", CommandID: id, NodeID: "macair", SessionID: "fixture-session",
		Action: protocol.ActionApprove, ExpectedTurnID: "turn-1", SendRoute: route, ApprovalRequestID: "7",
		ApprovalDecision: protocol.ApprovalAccept, ExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)}
}

func TestApproveCommandReceipts(t *testing.T) {
	for _, tc := range []struct {
		name   string
		route  protocol.SendRoute
		err    error
		want   protocol.DaemonResultStatus
		errSub string
	}{
		{"resolved", protocol.RouteControlSocket, nil, protocol.StatusCompleted, ""},
		{"uncertain", protocol.RouteControlSocket, &codex.UncertainError{Err: errors.New("no resolution")}, protocol.StatusUncertain, "no resolution"},
		{"not-pending", protocol.RouteControlSocket, codex.ErrApprovalNotPending, protocol.StatusFailed, "no longer pending"},
		{"desktop-unreachable", protocol.RouteDesktopOwner, codex.ErrApprovalUnreachable, protocol.StatusFailed, "请在桌面端处理审批"},
		{"control-unreachable", protocol.RouteControlSocket, codex.ErrApprovalUnreachable, protocol.StatusFailed, "不可达"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := persistenceConfig(t.TempDir())
			adapter := &approvalAdapter{endpoint: cfg.SocketPath, err: tc.err}
			d, err := OpenDaemon(cfg, adapter)
			if err != nil {
				t.Fatal(err)
			}
			defer closeDaemon(t, d)
			cmd := approveCommand("approve-"+tc.name, tc.route)
			res := d.ExecuteCommand(context.Background(), cmd)
			if res.Status != tc.want || !strings.Contains(res.Error, tc.errSub) {
				t.Fatalf("result = %+v", res)
			}
			if tc.want == protocol.StatusCompleted && (res.TurnID != "turn-1" || res.Output != approvalResolvedOutput) {
				t.Fatalf("completed receipt = %+v", res)
			}
			// The same command id is idempotent: no second answer is written.
			if again := d.ExecuteCommand(context.Background(), cmd); again.Status != res.Status || adapter.answers.Load() != 1 {
				t.Fatalf("duplicate executed again: %+v answers=%d", again, adapter.answers.Load())
			}
		})
	}
}

func TestApproveCommandRejectsTerminalAndClaudeTargets(t *testing.T) {
	cfg := persistenceConfig(t.TempDir())
	adapter := &approvalAdapter{endpoint: cfg.SocketPath}
	d, err := OpenDaemon(cfg, adapter)
	if err != nil {
		t.Fatal(err)
	}
	defer closeDaemon(t, d)
	for _, session := range []string{"terminal:pane-1", protocol.ClaudeSessionPrefix + "abc"} {
		cmd := approveCommand("approve-"+session, "")
		cmd.SessionID = session
		if res := d.ExecuteCommand(context.Background(), cmd); res.Status != protocol.StatusFailed {
			t.Fatalf("%s accepted: %+v", session, res)
		}
	}
	if adapter.answers.Load() != 0 {
		t.Fatal("unsupported target was answered")
	}
}

func TestPendingApprovalProbeIsBoundedAndCached(t *testing.T) {
	cfg := persistenceConfig(t.TempDir())
	adapter := &approvalAdapter{endpoint: cfg.SocketPath, pending: []protocol.PendingApproval{{RequestID: "7", Kind: protocol.ApprovalKindCommand}}}
	d := NewDaemon(cfg, adapter)
	loaded, unloaded := true, false
	sessions := func() []protocol.Session {
		out := []protocol.Session{}
		for _, id := range []string{"a", "b", "c"} {
			out = append(out, protocol.Session{ID: id, Status: sessionStatusWaitingApproval, Loaded: &loaded})
		}
		return append(out, protocol.Session{ID: "d", Status: sessionStatusWaitingApproval, Loaded: &unloaded},
			protocol.Session{ID: "e", Status: "active", Loaded: &loaded})
	}
	first := sessions()
	d.attachPendingApprovals(context.Background(), first)
	if adapter.probes.Load() != maxApprovalProbesPerRefresh || len(first[0].PendingApprovals) != 1 || first[2].PendingApprovals != nil ||
		first[3].PendingApprovals != nil || first[4].PendingApprovals != nil {
		t.Fatalf("probes=%d sessions=%+v", adapter.probes.Load(), first)
	}
	second := sessions()
	d.attachPendingApprovals(context.Background(), second)
	if adapter.probes.Load() != maxApprovalProbesPerRefresh+1 || len(second[0].PendingApprovals) != 1 || len(second[2].PendingApprovals) != 1 {
		t.Fatalf("cache not reused: probes=%d", adapter.probes.Load())
	}
	d.attachPendingApprovals(context.Background(), []protocol.Session{{ID: "a", Status: "idle", Loaded: &loaded}})
	if len(d.approvals.probes) != 0 {
		t.Fatal("stale approvals retained after leaving waitingApproval")
	}
}
