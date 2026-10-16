package client

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	codexdesktop "github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/desktop"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const fixtureDesktopSocket = "/test/desktop"

type fixtureDesktopController struct {
	prepares, sends, closes, inspections atomic.Int32
	prepareErr, dispatchErr, inspectErr  error
	turnID                               string
	beforePrepare                        func(codexdesktop.DesktopSendRequest)
	beforeDispatch                       func(protocol.DispatchIdentity)
}

type fixturePreparedDesktop struct {
	controller *fixtureDesktopController
	identity   protocol.DispatchIdentity
}

func (f *fixtureDesktopController) CheckSendReadiness(context.Context, string) error {
	return errors.New("fixture readiness check not configured")
}

func (f *fixtureDesktopController) PrepareSend(_ context.Context, req codexdesktop.DesktopSendRequest) (codexdesktop.PreparedDesktopSend, error) {
	f.prepares.Add(1)
	if f.beforePrepare != nil {
		f.beforePrepare(req)
	}
	if f.prepareErr != nil {
		return nil, f.prepareErr
	}
	return &fixturePreparedDesktop{controller: f, identity: protocol.DispatchIdentity{
		Route: protocol.RouteDesktopOwner, SessionID: req.SessionID, ClientUserMessageID: req.ClientUserMessageID,
		RequestID: req.RequestID, OwnerID: "fixture-owner", ConnectionID: "fixture-connection", Endpoint: fixtureDesktopSocket,
	}}, nil
}

func (p *fixturePreparedDesktop) Identity() protocol.DispatchIdentity { return p.identity }
func (p *fixturePreparedDesktop) Close()                              { p.controller.closes.Add(1) }
func (p *fixturePreparedDesktop) Dispatch(_ context.Context, _ string) (string, error) {
	p.controller.sends.Add(1)
	if p.controller.beforeDispatch != nil {
		p.controller.beforeDispatch(p.identity)
	}
	return p.controller.turnID, p.controller.dispatchErr
}

func (f *fixtureDesktopController) InspectTurn(_ context.Context, sessionID, turnID string) (codex.TurnObservation, error) {
	f.inspections.Add(1)
	if sessionID != "fixture-session" || turnID != "desktop-turn" {
		return codex.TurnObservation{}, errors.New("unexpected inspection target")
	}
	return codex.TurnObservation{Status: "completed", Output: "exact desktop turn output"}, f.inspectErr
}

func desktopCommand() protocol.ControllerCommandMessage {
	cmd := persistenceCommand(time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano))
	cmd.SendRoute = protocol.RouteDesktopOwner
	return cmd
}

func TestDesktopRoutePersistsBeforeSendAndReplaysWithoutSending(t *testing.T) {
	control := &receiptAdapter{}
	dir := t.TempDir()
	cfg := persistenceConfig(dir)
	cfg.DesktopSocketPath = fixtureDesktopSocket
	cfg.DesktopSend = true
	d, err := OpenDaemon(cfg, control)
	if err != nil {
		t.Fatal(err)
	}
	cmd := desktopCommand()
	desktop := &fixtureDesktopController{turnID: "desktop-turn"}
	d.desktopController = desktop
	desktop.beforePrepare = func(req codexdesktop.DesktopSendRequest) {
		entry, found, err := d.journal.Lookup(cmd)
		if err != nil || !found || entry.Dispatch == nil || entry.Dispatch.RequestID != req.RequestID || entry.Dispatch.ClientUserMessageID != req.ClientUserMessageID {
			t.Fatalf("prepare without persisted request IDs: %+v %v", entry, err)
		}
	}
	desktop.beforeDispatch = func(identity protocol.DispatchIdentity) {
		entry, found, err := d.journal.Lookup(cmd)
		if err != nil || !found || entry.Dispatch == nil || *entry.Dispatch != identity || entry.Finished {
			t.Fatalf("mutation before bound identity commit: %+v %v", entry, err)
		}
	}
	res := d.ExecuteCommand(context.Background(), cmd)
	if res.Status != protocol.StatusAccepted || res.TurnID != "desktop-turn" || desktop.sends.Load() != 1 || desktop.closes.Load() != 1 || control.sends.Load() != 0 {
		t.Fatalf("unexpected desktop dispatch: %+v", res)
	}
	if replay := d.ExecuteCommand(context.Background(), cmd); replay != res || desktop.sends.Load() != 1 {
		t.Fatal("duplicate desktop send")
	}
	if err := d.ackResult(protocol.ResultAckMessage{Type: "result_ack", CommandID: res.CommandID, TurnID: res.TurnID, Status: res.Status}); err != nil {
		t.Fatal(err)
	}
	closeDaemon(t, d)
	d, err = OpenDaemon(cfg, control)
	if err != nil {
		t.Fatal(err)
	}
	defer closeDaemon(t, d)
	desktop = &fixtureDesktopController{turnID: "desktop-turn"}
	d.desktopController = desktop
	if replay := d.ExecuteCommand(context.Background(), cmd); replay.Status != protocol.StatusAccepted || replay.TurnID != "desktop-turn" || desktop.prepares.Load() != 0 {
		t.Fatal("restarted desktop claim was replayed")
	}
	msg := protocol.InspectTurnMessage{Type: "inspect_turn", CommandID: cmd.CommandID, NodeID: cmd.NodeID, SessionID: cmd.SessionID, TurnID: res.TurnID}
	if observed := d.InspectTurn(context.Background(), msg); observed.Status != protocol.StatusCompleted || observed.Output != "exact desktop turn output" {
		t.Fatalf("lost route after ACK/restart: %+v", observed)
	}
	msg.TurnID = "different-turn"
	if observed := d.InspectTurn(context.Background(), msg); observed.Status != protocol.StatusUncertain || desktop.inspections.Load() != 1 {
		t.Fatal("inspection target mismatch reached runtime")
	}
	cfg.DesktopSocketPath = "/changed/desktop"
	msg.TurnID = res.TurnID
	if observed := d.InspectTurn(context.Background(), msg); observed.Status != protocol.StatusUncertain || desktop.inspections.Load() != 1 {
		t.Fatal("inspection silently changed runtime endpoint")
	}
}

type failedBindJournal struct{ commandJournal }

func (j *failedBindJournal) BindDispatch(protocol.ControllerCommandMessage, protocol.DispatchIdentity) error {
	return errors.New("fixture disk write failure")
}

func TestDesktopRouteNeverFallsBackOrRepeatsUncertainSend(t *testing.T) {
	for _, tc := range []struct {
		name                    string
		prepareErr, dispatchErr error
		turnID                  string
		failBind                bool
		want                    protocol.DaemonResultStatus
		wantSends               int32
	}{
		{name: "busy", prepareErr: errors.New("busy"), want: protocol.StatusFailed},
		{name: "bind-failed", failBind: true, want: protocol.StatusUncertain},
		{name: "lost-ack", dispatchErr: &codex.UncertainError{Err: errors.New("disconnected")}, want: protocol.StatusUncertain, wantSends: 1},
		{name: "bad-ack", turnID: "", want: protocol.StatusUncertain, wantSends: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			control := &receiptAdapter{}
			cfg := persistenceConfig(t.TempDir())
			cfg.DesktopSocketPath = fixtureDesktopSocket
			cfg.DesktopSend = true
			d, err := OpenDaemon(cfg, control)
			if err != nil {
				t.Fatal(err)
			}
			defer closeDaemon(t, d)
			desktop := &fixtureDesktopController{prepareErr: tc.prepareErr, dispatchErr: tc.dispatchErr, turnID: tc.turnID}
			d.desktopController = desktop
			if tc.failBind {
				d.journal = &failedBindJournal{d.journal}
			}
			cmd := desktopCommand()
			res := d.ExecuteCommand(context.Background(), cmd)
			if res.Status != tc.want || desktop.sends.Load() != tc.wantSends || control.sends.Load() != 0 {
				t.Fatalf("unsafe route result: %+v desktop=%d control=%d", res, desktop.sends.Load(), control.sends.Load())
			}
			if replay := d.ExecuteCommand(context.Background(), cmd); replay != res || desktop.prepares.Load() != 1 || desktop.sends.Load() != tc.wantSends {
				t.Fatal("uncertain/failed request was prepared twice")
			}
		})
	}
}

func TestDesktopRouteRequiresDurableJournal(t *testing.T) {
	control := &receiptAdapter{}
	cfg := persistenceConfig(t.TempDir())
	cfg.DesktopSend, cfg.DesktopSocketPath = true, fixtureDesktopSocket
	d := NewDaemon(cfg, control)
	desktop := &fixtureDesktopController{turnID: "desktop-turn"}
	d.desktopController = desktop
	if res := d.ExecuteCommand(context.Background(), desktopCommand()); res.Status != protocol.StatusFailed || desktop.prepares.Load() != 0 || control.sends.Load() != 0 {
		t.Fatalf("volatile desktop route allowed: %+v", res)
	}
}

func TestControlRouteDoesNotFallBackToDesktop(t *testing.T) {
	control := &inspectingAdapter{}
	d := NewDaemon(persistenceConfig(t.TempDir()), control)
	desktop := &fixtureDesktopController{turnID: "desktop-turn"}
	d.desktopController = desktop
	cmd := desktopCommand()
	cmd.SendRoute = protocol.RouteControlSocket
	if res := d.ExecuteCommand(context.Background(), cmd); res.Status != protocol.StatusFailed || desktop.prepares.Load() != 0 {
		t.Fatalf("native send failure fell back to desktop: %+v", res)
	}
}
