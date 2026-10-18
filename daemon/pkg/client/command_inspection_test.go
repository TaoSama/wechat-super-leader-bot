package client

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestInspectCommandRestoresExactReceiptWithoutTurnOrReplay(t *testing.T) {
	cfg := persistenceConfig(t.TempDir())
	a := &receiptAdapter{}
	d, err := OpenDaemon(cfg, a)
	if err != nil {
		t.Fatal(err)
	}
	cmd := persistenceCommand(time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano))
	if _, created, err := d.journal.Begin(cmd); err != nil || !created {
		t.Fatalf("claim: created=%v error=%v", created, err)
	}
	want := protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID, Status: protocol.StatusUncertain, Error: "original receipt without a turn ID"}
	if err := d.journal.Finish(want); err != nil {
		t.Fatal(err)
	}
	closeDaemon(t, d)
	d, err = OpenDaemon(cfg, a)
	if err != nil {
		t.Fatal(err)
	}
	defer closeDaemon(t, d)
	cmd.Type = "inspect_command"
	if got := d.InspectCommand(cmd); !protocol.SameResult(got, want) {
		t.Fatalf("lost expired original receipt: %+v", got)
	}
	wire, err := json.Marshal(cmd)
	if err != nil {
		t.Fatal(err)
	}
	var sent protocol.DaemonResultMessage
	if err := d.handleTrackingMessage(context.Background(), cmd.Type, wire, func(value any) error { sent = value.(protocol.DaemonResultMessage); return nil }); err != nil || !protocol.SameResult(sent, want) {
		t.Fatalf("inspection transport: %+v %v", sent, err)
	}
	for _, mutate := range []func(*protocol.ControllerCommandMessage){
		func(c *protocol.ControllerCommandMessage) { c.Prompt += "changed" },
		func(c *protocol.ControllerCommandMessage) { c.SessionID = "another-session" },
		func(c *protocol.ControllerCommandMessage) {
			c.DeliveryMode = protocol.DeliverySteer
			c.ExpectedTurnID = "another-turn"
		},
		func(c *protocol.ControllerCommandMessage) { c.CommandID = "missing-command" },
	} {
		changed := cmd
		mutate(&changed)
		if got := d.InspectCommand(changed); got.Status != protocol.StatusUncertain || got.Output != "" || got.Error == want.Error {
			t.Fatalf("conflicting/missing receipt accepted: %+v", got)
		}
	}
	if a.sends.Load() != 0 {
		t.Fatal("inspection replayed mutation")
	}
}

func TestInspectCommandRecoversAcceptedTurnAfterRestartWithoutRequestTurnID(t *testing.T) {
	cfg := persistenceConfig(t.TempDir())
	a := &receiptAdapter{}
	d, err := OpenDaemon(cfg, a)
	if err != nil {
		t.Fatal(err)
	}
	cmd := persistenceCommand(time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano))
	want := d.ExecuteCommand(context.Background(), cmd)
	if want.Status != protocol.StatusAccepted || want.TurnID != "durable-turn" {
		t.Fatalf("original receipt: %+v", want)
	}
	closeDaemon(t, d)
	d, err = OpenDaemon(cfg, a)
	if err != nil {
		t.Fatal(err)
	}
	defer closeDaemon(t, d)
	cmd.Type = "inspect_command"
	if got := d.InspectCommand(cmd); !protocol.SameResult(got, want) || a.sends.Load() != 1 {
		t.Fatalf("accepted turn was lost or replayed: %+v sends=%d", got, a.sends.Load())
	}
}

func TestControllerFinalResultHasSeparateLosslessWireBudget(t *testing.T) {
	body := strings.Repeat("<界>\n", protocol.MaxControllerMessageBytes/5)
	res := protocol.DaemonResultMessage{Type: "result", CommandID: "command", TurnID: "exact-turn", Status: protocol.StatusCompleted, Output: body}
	for _, input := range []any{res, &res} {
		wire, err := encodeControllerMessage(input)
		if err != nil || len(wire) <= protocol.MaxControllerMessageBytes {
			t.Fatalf("large final result rejected: bytes=%d error=%v", len(wire), err)
		}
		var decoded protocol.DaemonResultMessage
		if err := json.Unmarshal(wire, &decoded); err != nil || decoded.Output != body {
			t.Fatalf("large result changed: %v", err)
		}
	}
	for _, bad := range []string{strings.Repeat("x", protocol.MaxTurnOutputBytes+1), string([]byte{0xff})} {
		res.Output = bad
		if wire, err := encodeControllerMessage(res); err == nil || wire != nil {
			t.Fatal("invalid output became a sendable repaired or shortened body")
		}
	}
	if wire, err := encodeControllerMessage(protocol.DaemonHelloMessage{Type: "hello", NodeID: body}); err == nil || wire != nil {
		t.Fatal("result budget leaked into inventory")
	}
}
