package journal

import (
	"errors"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestResumeDispatchEndpointBindingAndExactInspection(t *testing.T) {
	dir := testPrivateDir(t)
	j, err := Open(dir, dispatchTestScope)
	if err != nil {
		t.Fatal(err)
	}
	cmd := desktopCommand("resume-dispatch")
	cmd.SendRoute = protocol.RouteAppServerResume
	identity := claimDesktop(t, j, cmd)
	for _, edit := range []func(*protocol.DispatchIdentity){
		func(i *protocol.DispatchIdentity) { i.Endpoint = "relative.sock" },
		func(i *protocol.DispatchIdentity) { i.OwnerID = "invented-owner" },
		func(i *protocol.DispatchIdentity) { i.ConnectionID = "invented-connection" },
		func(i *protocol.DispatchIdentity) { i.Route = protocol.RouteDesktopOwner },
		func(i *protocol.DispatchIdentity) { i.RequestID = "bad-request" },
	} {
		bad := identity
		bad.Endpoint = "/fixture/managed.sock"
		edit(&bad)
		if err := j.BindDispatch(cmd, bad); err == nil {
			t.Fatal("invalid managed dispatch binding accepted")
		}
	}
	identity.Endpoint = "/fixture/managed.sock"
	if err := j.BindDispatch(cmd, identity); err != nil {
		t.Fatal(err)
	}
	if err := j.BindDispatch(cmd, identity); err != nil {
		t.Fatalf("same endpoint binding not idempotent: %v", err)
	}
	changed := identity
	changed.Endpoint = "/different/managed.sock"
	if err := j.BindDispatch(cmd, changed); err == nil {
		t.Fatal("managed endpoint changed after binding")
	}
	result := protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID, Status: protocol.StatusAccepted, TurnID: "restored-turn"}
	if err := j.Finish(result); err != nil {
		t.Fatal(err)
	}
	for _, turnID := range []string{"", "other-turn"} {
		if _, err := j.ReadDispatch(cmd.CommandID, cmd.SessionID, turnID); err == nil || errors.Is(err, ErrNoDispatch) {
			t.Fatal("inexact managed receipt allowed inspection fallback")
		}
	}
	if err := j.Ack(protocol.ResultAckMessage{Type: "result_ack", CommandID: cmd.CommandID, Status: result.Status, TurnID: result.TurnID}); err != nil {
		t.Fatal(err)
	}
	closeJournal(t, j)
	j, err = Open(dir, dispatchTestScope)
	if err != nil {
		t.Fatal(err)
	}
	defer closeJournal(t, j)
	if got, err := j.ReadDispatch(cmd.CommandID, cmd.SessionID, result.TurnID); err != nil || got != identity {
		t.Fatalf("ACK/restart lost exact managed endpoint: %+v %v", got, err)
	}
	if entry, created, err := j.Begin(cmd); err != nil || created || entry.Result.Status != protocol.StatusAccepted {
		t.Fatal("finished managed command became executable")
	}
}

func TestResumeDispatchUnfinishedRestartNeverReplays(t *testing.T) {
	for _, bound := range []bool{false, true} {
		t.Run(map[bool]string{false: "claim", true: "bound"}[bound], func(t *testing.T) {
			dir := testPrivateDir(t)
			j, err := Open(dir, dispatchTestScope)
			if err != nil {
				t.Fatal(err)
			}
			cmd := desktopCommand("unfinished-resume")
			cmd.SendRoute = protocol.RouteAppServerResume
			identity := claimDesktop(t, j, cmd)
			identity.Endpoint = "/fixture/managed.sock"
			if bound {
				if err := j.BindDispatch(cmd, identity); err != nil {
					t.Fatal(err)
				}
			}
			closeJournal(t, j)
			j, err = Open(dir, dispatchTestScope)
			if err != nil {
				t.Fatal(err)
			}
			defer closeJournal(t, j)
			if entry, created, err := j.Begin(cmd); err != nil || created || !entry.Finished || entry.Result.Status != protocol.StatusUncertain {
				t.Fatal("unfinished managed command replayed after restart")
			}
			if err := j.BindDispatch(cmd, identity); err == nil {
				t.Fatal("restart-recovered command rebound")
			}
		})
	}
}
