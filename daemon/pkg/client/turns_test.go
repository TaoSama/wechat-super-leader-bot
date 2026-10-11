package client

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type inspectingAdapter struct {
	status string
	err    error
	calls  int
}

func (a *inspectingAdapter) DiscoverSessions(context.Context) ([]protocol.Session, error) {
	return nil, nil
}
func (a *inspectingAdapter) ReadSession(context.Context, string) (string, error) {
	return "", errors.New("unexpected session read")
}
func (a *inspectingAdapter) SendPrompt(context.Context, string, string) (string, error) {
	return "", errors.New("unexpected send")
}
func (a *inspectingAdapter) InspectTurn(_ context.Context, session, turn string) (codex.TurnObservation, error) {
	a.calls++
	if session != "session" || turn != "target" {
		return codex.TurnObservation{}, errors.New("wrong identity")
	}
	return codex.TurnObservation{Status: a.status, Output: "exact turn output"}, a.err
}

func TestInspectTurnStates(t *testing.T) {
	for _, tc := range []struct {
		state string
		want  protocol.DaemonResultStatus
	}{
		{"inProgress", protocol.StatusAccepted}, {"completed", protocol.StatusCompleted},
		{"failed", protocol.StatusFailed}, {"interrupted", protocol.StatusFailed}, {"unknown", protocol.StatusUncertain},
	} {
		t.Run(tc.state, func(t *testing.T) {
			a := &inspectingAdapter{status: tc.state}
			d := NewDaemon(&config.Config{NodeID: "demoair"}, a)
			msg := protocol.InspectTurnMessage{Type: "inspect_turn", CommandID: "command", NodeID: "demoair", SessionID: "session", TurnID: "target"}
			res := d.InspectTurn(context.Background(), msg)
			if res.Status != tc.want || res.TurnID != "target" {
				t.Fatalf("unexpected result: %+v", res)
			}
			msg.NodeID = "other"
			if d.InspectTurn(context.Background(), msg).Status != protocol.StatusUncertain || a.calls != 1 {
				t.Fatal("invalid identity reached adapter")
			}
		})
	}
}

func TestInspectionFailureIsUncertainAndRetryable(t *testing.T) {
	a := &inspectingAdapter{status: "completed", err: errors.New("private upstream detail")}
	d := NewDaemon(&config.Config{NodeID: "demoair"}, a)
	msg := protocol.InspectTurnMessage{Type: "inspect_turn", CommandID: "command", NodeID: "demoair", SessionID: "session", TurnID: "target"}
	res := d.InspectTurn(context.Background(), msg)
	if res.Status != protocol.StatusUncertain || res.Output != "" || res.Error == a.err.Error() {
		t.Fatalf("unsafe failure: %+v", res)
	}
	a.err = nil
	if d.InspectTurn(context.Background(), msg).Status != protocol.StatusCompleted {
		t.Fatal("read failure was cached permanently")
	}
}

func TestResultOutboxRequiresMatchingPersistenceAck(t *testing.T) {
	d := NewDaemon(&config.Config{}, &inspectingAdapter{})
	res := protocol.DaemonResultMessage{Type: "result", CommandID: "command", TurnID: "target", Status: protocol.StatusAccepted}
	if !d.reserveResult(res.CommandID) {
		t.Fatal("reservation failed")
	}
	d.queueResult(res)
	fail := errors.New("disconnected")
	if !errors.Is(d.flushResults(func(any) error { return fail }), fail) {
		t.Fatal("write failure lost")
	}
	if err := d.ackResult(protocol.ResultAckMessage{CommandID: "command", TurnID: "wrong", Status: protocol.StatusAccepted}); err != nil {
		t.Fatal(err)
	}
	if err := d.ackResult(protocol.ResultAckMessage{CommandID: "command", TurnID: "target", Status: protocol.StatusCompleted}); err != nil {
		t.Fatal(err)
	}
	count := 0
	send := func(msg any) error {
		count++
		if msg != res {
			t.Fatalf("wrong replay: %+v", msg)
		}
		return nil
	}
	if err := d.flushResults(send); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatal("result dropped without matching ack")
	}
	if err := d.ackResult(protocol.ResultAckMessage{CommandID: "command", TurnID: "target", Status: protocol.StatusAccepted}); err != nil {
		t.Fatal(err)
	}
	if err := d.flushResults(send); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatal("acknowledged result replayed")
	}
}

func TestTurnIDParsing(t *testing.T) {
	for _, raw := range []string{"", "accepted", "turnId=", "turnId=one two", "turnId=one\n"} {
		if parseTurnID(raw) != "" {
			t.Fatalf("invalid acknowledgement parsed: %q", raw)
		}
	}
	if parseTurnID("turnId=target") != "target" {
		t.Fatal("missing turn id")
	}
}

func TestResultBacklogRejectsNewReservationsWithoutDroppingResults(t *testing.T) {
	d := NewDaemon(&config.Config{}, &inspectingAdapter{})
	for i := 0; i < MaxDedupeEntries; i++ {
		if !d.reserveResult(fmt.Sprintf("cmd-%d", i)) {
			t.Fatal("premature backlog rejection")
		}
	}
	if d.reserveResult("overflow") {
		t.Fatal("unbounded result backlog")
	}
	if !d.reserveResult("cmd-0") {
		t.Fatal("duplicate command reservation rejected")
	}
	if len(d.outbox) != MaxDedupeEntries {
		t.Fatal("backlog entry dropped")
	}
}
