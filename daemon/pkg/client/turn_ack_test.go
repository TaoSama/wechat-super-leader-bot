package client

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type acknowledgedTurnAdapter struct {
	receiptAdapter
	observation codex.TurnObservation
	inspections int
}

func (a *acknowledgedTurnAdapter) InspectTurn(_ context.Context, sessionID, turnID string) (codex.TurnObservation, error) {
	a.inspections++
	if sessionID != "fixture-session" || turnID != "durable-turn" {
		return codex.TurnObservation{}, errors.New("unexpected turn identity")
	}
	return a.observation, nil
}

func TestInspectTurnFinalReceiptRemainsExactAfterAckAndRestart(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status string
		output string
	}{
		{name: "completed-text", status: "completed", output: "\n# 完整结果\n\n  Markdown  \n"},
		{name: "completed-empty", status: "completed"},
		{name: "failed-error", status: "failed", output: "partial output"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := persistenceConfig(t.TempDir())
			adapter := &acknowledgedTurnAdapter{observation: codex.TurnObservation{Status: tc.status, Output: tc.output}}
			d, err := OpenDaemon(cfg, adapter)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if d != nil {
					closeDaemon(t, d)
				}
			})
			cmd := persistenceCommand(time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano))
			accepted := d.ExecuteCommand(context.Background(), cmd)
			if accepted.Status != protocol.StatusAccepted || accepted.TurnID != "durable-turn" {
				t.Fatalf("initial dispatch: %+v", accepted)
			}
			msg := protocol.InspectTurnMessage{Type: "inspect_turn", CommandID: cmd.CommandID,
				NodeID: cmd.NodeID, SessionID: cmd.SessionID, TurnID: accepted.TurnID}
			want := protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID,
				TurnID: accepted.TurnID, Status: protocol.StatusCompleted, Output: tc.output, OutputPresent: tc.output == ""}
			if tc.status == "failed" {
				want.Status, want.Error, want.OutputPresent = protocol.StatusFailed, "Turn failed", false
			}
			inspectExact := func(stage string) {
				t.Helper()
				got := d.InspectTurn(context.Background(), msg)
				if !protocol.SameResult(got, want) {
					t.Fatalf("%s changed exact native receipt: status=%s outputPresent=%t error=%q", stage, got.Status, got.HasOutput(), got.Error)
				}
			}
			inspectExact("first inspection")
			inspectExact("repeat before ACK")
			if err := d.ackResult(protocol.ResultAckMessage{Type: "result_ack", CommandID: cmd.CommandID,
				TurnID: want.TurnID, Status: want.Status}); err != nil {
				t.Fatal(err)
			}
			assertPruned := func() {
				t.Helper()
				entry, found, err := d.journal.Lookup(cmd)
				if err != nil || !found || !entry.Acknowledged || entry.Result.HasOutput() || entry.Result.Error != "" {
					t.Fatalf("ACK did not retain a pruned receipt: found=%t err=%v", found, err)
				}
				pending, err := d.journal.Unacked()
				if err != nil || len(pending) != 0 {
					t.Fatalf("ACKed receipt rearmed delivery: count=%d err=%v", len(pending), err)
				}
			}
			assertPruned()
			inspectExact("repeat after ACK")
			assertPruned()
			closeDaemon(t, d)
			d = nil
			d, err = OpenDaemon(cfg, adapter)
			if err != nil {
				t.Fatal(err)
			}
			inspectExact("repeat after restart")
			assertPruned()
			if adapter.sends.Load() != 1 || adapter.inspections != 4 {
				t.Fatalf("unexpected execution/inspection calls: sends=%d inspections=%d", adapter.sends.Load(), adapter.inspections)
			}
			t.Logf("beforeACK=%s afterACK=%s afterRestart=%s nativeInspections=%d sends=%d bodyPruned=true pending=0",
				want.Status, want.Status, want.Status, adapter.inspections, adapter.sends.Load())
		})
	}
}
