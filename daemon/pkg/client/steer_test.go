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

type steerReceiptAdapter struct {
	receiptAdapter
	steers      atomic.Int32
	inspections atomic.Int32
	endpoint    string
	steerErr    error
	turnID      string
	output      string
	inspectErr  error
	beforeSteer func()
}

func (a *steerReceiptAdapter) Endpoint() string { return a.endpoint }
func (a *steerReceiptAdapter) ResumeSend(context.Context, string, string) (string, error) {
	return "", errors.New("steering attempted resume mutation")
}
func (a *steerReceiptAdapter) SteerPrompt(_ context.Context, sessionID, prompt, expected string) (string, error) {
	a.steers.Add(1)
	if sessionID != "fixture-session" || prompt != "fixture only" || expected != "active-turn" {
		return "", errors.New("inexact steer target or body")
	}
	if a.beforeSteer != nil {
		a.beforeSteer()
	}
	return a.turnID, a.steerErr
}
func (a *steerReceiptAdapter) InspectTurn(_ context.Context, sessionID, turnID string) (codex.TurnObservation, error) {
	a.inspections.Add(1)
	if sessionID != "fixture-session" || turnID != "active-turn" {
		return codex.TurnObservation{}, errors.New("inexact turn inspection")
	}
	return codex.TurnObservation{Status: "completed", Output: a.output}, a.inspectErr
}

func TestSteerCommandPersistsExactIdentityAndNeverFallsBack(t *testing.T) {
	for _, tc := range []struct {
		name   string
		route  protocol.SendRoute
		turnID string
		err    error
		want   protocol.DaemonResultStatus
		calls  int32
	}{
		{"control", protocol.RouteControlSocket, "active-turn", nil, protocol.StatusAccepted, 1},
		{"managed", protocol.RouteAppServerResume, "active-turn", nil, protocol.StatusAccepted, 1},
		{"desktop-unsupported", protocol.RouteDesktopOwner, "", nil, protocol.StatusFailed, 0},
		{"native-rejected", protocol.RouteControlSocket, "", errors.New("active turn mismatch"), protocol.StatusFailed, 1},
		{"lost-ack", protocol.RouteControlSocket, "", &codex.UncertainError{Err: errors.New("lost ack")}, protocol.StatusUncertain, 1},
		{"wrong-ack", protocol.RouteControlSocket, "wrong-turn", nil, protocol.StatusUncertain, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := persistenceConfig(t.TempDir())
			a := &steerReceiptAdapter{endpoint: cfg.SocketPath, steerErr: tc.err, turnID: tc.turnID}
			d, err := OpenDaemon(cfg, a)
			if err != nil {
				t.Fatal(err)
			}
			defer closeDaemon(t, d)
			cmd := persistenceCommand(time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano))
			cmd.SendRoute, cmd.DeliveryMode, cmd.ExpectedTurnID = tc.route, protocol.DeliverySteer, "active-turn"
			a.beforeSteer = func() {
				entry, found, err := d.journal.Lookup(cmd)
				if err != nil || !found || entry.Finished || (tc.route == protocol.RouteAppServerResume && (entry.Dispatch == nil || entry.Dispatch.Endpoint != cfg.SocketPath)) {
					t.Errorf("steer preceded durable binding: %+v %v", entry, err)
				}
			}
			got := d.ExecuteCommand(context.Background(), cmd)
			if got.Status != tc.want || a.steers.Load() != tc.calls || a.sends.Load() != 0 {
				t.Fatalf("result=%+v steers=%d starts=%d", got, a.steers.Load(), a.sends.Load())
			}
			cmd.Type = "inspect_command"
			if inspected := d.InspectCommand(cmd); !protocol.SameResult(inspected, got) || a.steers.Load() != tc.calls {
				t.Fatalf("inspection replayed steer or lost receipt: %+v", inspected)
			}
			cmd.Type = "command"
			cmd.ExpectedTurnID = "another-turn"
			if changed := d.ExecuteCommand(context.Background(), cmd); changed.Status != protocol.StatusUncertain || a.steers.Load() != tc.calls {
				t.Fatalf("conflicting turn repeated steer: %+v", changed)
			}
		})
	}
}

func TestInspectedTerminalReceiptSurvivesRestartAndOldAck(t *testing.T) {
	for _, tc := range []struct {
		name       string
		inspectErr error
		want       protocol.DaemonResultStatus
	}{
		{"completed", nil, protocol.StatusCompleted},
		{"overflow", protocol.ErrTurnOutputLimit, protocol.StatusFailed},
		{"native-response-overflow", protocol.ErrTurnObservationLimit, protocol.StatusFailed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := persistenceConfig(t.TempDir())
			a := &steerReceiptAdapter{turnID: "active-turn", output: "\n# Result\n\n" + strings.Repeat("<界>  \n", 50000), inspectErr: tc.inspectErr}
			d, err := OpenDaemon(cfg, a)
			if err != nil {
				t.Fatal(err)
			}
			cmd := persistenceCommand(time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano))
			cmd.DeliveryMode, cmd.ExpectedTurnID = protocol.DeliverySteer, "active-turn"
			accepted := d.ExecuteCommand(context.Background(), cmd)
			if accepted.Status != protocol.StatusAccepted {
				t.Fatalf("send: %+v", accepted)
			}
			ack := protocol.ResultAckMessage{Type: "result_ack", CommandID: cmd.CommandID, TurnID: accepted.TurnID, Status: accepted.Status}
			if err := d.ackResult(ack); err != nil {
				t.Fatal(err)
			}
			msg := protocol.InspectTurnMessage{Type: "inspect_turn", CommandID: cmd.CommandID, NodeID: cmd.NodeID, SessionID: cmd.SessionID, TurnID: accepted.TurnID}
			result := d.InspectTurn(context.Background(), msg)
			if result.Status != tc.want || (tc.want == protocol.StatusCompleted && result.Output != a.output) || (tc.want == protocol.StatusFailed && (result.Output != "" || result.Error != tc.inspectErr.Error())) {
				t.Fatalf("inspection: %+v", result)
			}
			if err := d.ackResult(ack); err != nil {
				t.Fatal(err)
			}
			closeDaemon(t, d)
			d, err = OpenDaemon(cfg, a)
			if err != nil {
				t.Fatal(err)
			}
			defer closeDaemon(t, d)
			cmd.Type = "inspect_command"
			if replay := d.InspectCommand(cmd); !protocol.SameResult(replay, result) || a.steers.Load() != 1 {
				t.Fatalf("restart: %+v", replay)
			}
			pending, err := d.journal.Unacked()
			if err != nil || len(pending) != 1 || !protocol.SameResult(pending[0], result) {
				t.Fatalf("pending=%+v error=%v", pending, err)
			}
			msg.SessionID = "wrong-session"
			if got := d.InspectTurn(context.Background(), msg); got.Status != protocol.StatusUncertain || a.inspections.Load() != 1 {
				t.Fatalf("inexact inspection reached native: %+v inspections=%d", got, a.inspections.Load())
			}
		})
	}
}
