package client

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	interruptTestTurn    = "running-turn"
	interruptTestTimeout = 1500 * time.Millisecond
)

// interruptRuntime records exact interrupt calls and replays scripted turn states.
type interruptRuntime struct {
	mu           sync.Mutex
	statuses     []string
	inspectErr   error
	interruptErr error
	interrupts   atomic.Int32
	inspections  atomic.Int32
}

func (r *interruptRuntime) InterruptTurn(_ context.Context, sessionID, turnID string) error {
	r.interrupts.Add(1)
	if sessionID != "fixture-session" || turnID != interruptTestTurn {
		return errors.New("inexact interrupt target")
	}
	return r.interruptErr
}

func (r *interruptRuntime) InspectTurn(_ context.Context, sessionID, turnID string) (codex.TurnObservation, error) {
	r.inspections.Add(1)
	if sessionID != "fixture-session" {
		return codex.TurnObservation{}, errors.New("inexact inspection target")
	}
	if turnID != interruptTestTurn {
		return codex.TurnObservation{}, errors.New("turn not found")
	}
	if r.inspectErr != nil {
		return codex.TurnObservation{}, r.inspectErr
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	status := r.statuses[0]
	if len(r.statuses) > 1 {
		r.statuses = r.statuses[1:]
	}
	return codex.TurnObservation{Status: status}, nil
}

type interruptAdapter struct {
	receiptAdapter
	*interruptRuntime
	endpoint string
}

func (a *interruptAdapter) Endpoint() string { return a.endpoint }
func (a *interruptAdapter) ResumeSend(context.Context, string, string) (string, error) {
	return "", errors.New("interrupt attempted resume mutation")
}

type interruptDesktop struct {
	*fixtureDesktopController
	*interruptRuntime
}

func (d *interruptDesktop) InspectTurn(ctx context.Context, sessionID, turnID string) (codex.TurnObservation, error) {
	return d.interruptRuntime.InspectTurn(ctx, sessionID, turnID)
}

func interruptCommand(route protocol.SendRoute, turnID string) protocol.ControllerCommandMessage {
	return protocol.ControllerCommandMessage{Type: "command", CommandID: "interrupt-command", NodeID: "macair", SessionID: "fixture-session",
		Action: protocol.ActionInterrupt, ExpectedTurnID: turnID, SendRoute: route,
		ExpiresAt: time.Now().Add(interruptTestTimeout).UTC().Format(time.RFC3339Nano)}
}

func TestInterruptCommandRoutesAndReceipts(t *testing.T) {
	for _, tc := range []struct {
		name       string
		route      protocol.SendRoute
		turnID     string
		statuses   []string
		inspectErr error
		err        error
		want       protocol.DaemonResultStatus
		output     string
		errorText  string
		interrupts int32
	}{
		{name: "control-confirmed", route: protocol.RouteControlSocket, statuses: []string{"inProgress", "interrupted"}, want: protocol.StatusCompleted, output: "interrupted", interrupts: 1},
		{name: "managed-confirmed", route: protocol.RouteAppServerResume, statuses: []string{"inProgress", "interrupted"}, want: protocol.StatusCompleted, output: "interrupted", interrupts: 1},
		{name: "desktop-confirmed", route: protocol.RouteDesktopOwner, statuses: []string{"inProgress", "inProgress", "interrupted"}, want: protocol.StatusCompleted, output: "interrupted", interrupts: 1},
		{name: "finished-concurrently", route: protocol.RouteControlSocket, statuses: []string{"inProgress", "completed"}, want: protocol.StatusCompleted, output: "completed", interrupts: 1},
		{name: "not-running", route: protocol.RouteControlSocket, statuses: []string{"completed"}, want: protocol.StatusFailed, errorText: "not running", interrupts: 0},
		{name: "mismatched-turn", route: protocol.RouteControlSocket, turnID: "other-turn", statuses: []string{"inProgress"}, want: protocol.StatusFailed, errorText: "state unavailable", interrupts: 0},
		{name: "state-unavailable", route: protocol.RouteDesktopOwner, inspectErr: errors.New("owner gone"), statuses: []string{"inProgress"}, want: protocol.StatusFailed, errorText: "state unavailable", interrupts: 0},
		{name: "rejected", route: protocol.RouteControlSocket, statuses: []string{"inProgress"}, err: errors.New("turn/interrupt rejected"), want: protocol.StatusFailed, errorText: "rejected", interrupts: 1},
		{name: "uncertain", route: protocol.RouteDesktopOwner, statuses: []string{"inProgress"}, err: &codex.UncertainError{Err: errors.New("lost ack")}, want: protocol.StatusUncertain, errorText: "lost ack", interrupts: 1},
		{name: "unconfirmed-stop", route: protocol.RouteControlSocket, statuses: []string{"inProgress"}, want: protocol.StatusUncertain, errorText: "not yet confirmed", interrupts: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := persistenceConfig(t.TempDir())
			cfg.DesktopSocketPath, cfg.DesktopSend = fixtureDesktopSocket, true
			runtime := &interruptRuntime{statuses: tc.statuses, inspectErr: tc.inspectErr, interruptErr: tc.err}
			control := &interruptRuntime{statuses: []string{"inProgress"}}
			adapter := &interruptAdapter{endpoint: cfg.SocketPath, interruptRuntime: control}
			desktopRuntime := &interruptRuntime{statuses: []string{"inProgress"}}
			if tc.route == protocol.RouteDesktopOwner {
				desktopRuntime = runtime
			} else {
				adapter.interruptRuntime = runtime
			}
			d, err := OpenDaemon(cfg, adapter)
			if err != nil {
				t.Fatal(err)
			}
			defer closeDaemon(t, d)
			d.desktopController = &interruptDesktop{fixtureDesktopController: &fixtureDesktopController{}, interruptRuntime: desktopRuntime}
			turnID := tc.turnID
			if turnID == "" {
				turnID = interruptTestTurn
			}
			cmd := interruptCommand(tc.route, turnID)
			res := d.ExecuteCommand(context.Background(), cmd)
			if res.Status != tc.want || res.Output != tc.output || !strings.Contains(res.Error, tc.errorText) {
				t.Fatalf("result = %+v", res)
			}
			if tc.want == protocol.StatusCompleted && res.TurnID != interruptTestTurn || tc.want != protocol.StatusCompleted && res.TurnID != "" {
				t.Fatalf("receipt turn = %q", res.TurnID)
			}
			if runtime.interrupts.Load() != tc.interrupts {
				t.Fatalf("interrupts = %d, want %d", runtime.interrupts.Load(), tc.interrupts)
			}
			other := control
			if tc.route != protocol.RouteDesktopOwner {
				other = desktopRuntime
			}
			if other.interrupts.Load() != 0 || other.inspections.Load() != 0 || adapter.sends.Load() != 0 {
				t.Fatal("interrupt fell back to another route or sent input")
			}
			if replay := d.ExecuteCommand(context.Background(), cmd); replay.Status != res.Status || runtime.interrupts.Load() != tc.interrupts {
				t.Fatalf("duplicate command replayed the interrupt: %+v", replay)
			}
		})
	}
}

func TestInterruptCommandFailsClosedWithoutRoute(t *testing.T) {
	for _, tc := range []struct {
		name  string
		cmd   protocol.ControllerCommandMessage
		setup func(*Daemon)
		want  string
	}{
		{"terminal", func() protocol.ControllerCommandMessage {
			cmd := interruptCommand("", interruptTestTurn)
			cmd.SessionID = "terminal:pane-1"
			return cmd
		}(), nil, protocol.TerminalInterruptUnsupported},
		{"desktop-disabled", interruptCommand(protocol.RouteDesktopOwner, interruptTestTurn), func(d *Daemon) { d.cfg.DesktopSend = false }, "desktop control is disabled"},
		{"desktop-without-interrupt", interruptCommand(protocol.RouteDesktopOwner, interruptTestTurn), func(d *Daemon) {
			d.desktopController = &fixtureDesktopController{}
		}, "cannot interrupt"},
		{"managed-endpoint-changed", interruptCommand(protocol.RouteAppServerResume, interruptTestTurn), func(d *Daemon) { d.cfg.SocketPath = "/other/socket" }, "original managed server"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := persistenceConfig(t.TempDir())
			cfg.DesktopSocketPath, cfg.DesktopSend = fixtureDesktopSocket, true
			runtime := &interruptRuntime{statuses: []string{"inProgress"}}
			d := NewDaemon(cfg, &interruptAdapter{endpoint: cfg.SocketPath, interruptRuntime: runtime})
			d.desktopController = &interruptDesktop{fixtureDesktopController: &fixtureDesktopController{}, interruptRuntime: runtime}
			if tc.setup != nil {
				tc.setup(d)
			}
			res := d.ExecuteCommand(context.Background(), tc.cmd)
			if res.Status != protocol.StatusFailed || !strings.Contains(res.Error, tc.want) || runtime.interrupts.Load() != 0 || runtime.inspections.Load() != 0 {
				t.Fatalf("result = %+v interrupts=%d", res, runtime.interrupts.Load())
			}
		})
	}
}
