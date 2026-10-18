package journal

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	bolt "go.etcd.io/bbolt"
)

func TestFullSizeEscapedOutputSurvivesJournalRestart(t *testing.T) {
	dir := testPrivateDir(t)
	j, err := Open(dir, "large-result-scope")
	if err != nil {
		t.Fatal(err)
	}
	cmd := testCommand("large-command", "task")
	if _, created, err := j.Begin(cmd); err != nil || !created {
		t.Fatalf("begin: %v", err)
	}
	output := strings.Repeat("<", protocol.MaxTurnOutputBytes)
	result := protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID,
		Status: protocol.StatusCompleted, TurnID: "target", Output: output}
	if err := j.Finish(result); err != nil {
		t.Fatal(err)
	}
	closeJournal(t, j)
	j, err = Open(dir, "large-result-scope")
	if err != nil {
		t.Fatal(err)
	}
	defer closeJournal(t, j)
	results, err := j.Unacked()
	if err != nil || len(results) != 1 || results[0].Output != output {
		t.Fatalf("full-size replay mismatch: results=%d error=%v", len(results), err)
	}
}

func TestOutputOverflowDoesNotFinalizeJournalReceipt(t *testing.T) {
	j, err := Open(testPrivateDir(t), "output-limit-scope")
	if err != nil {
		t.Fatal(err)
	}
	defer closeJournal(t, j)
	cmd := testCommand("overflow-command", "task")
	if _, _, err := j.Begin(cmd); err != nil {
		t.Fatal(err)
	}
	result := protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID,
		Status: protocol.StatusCompleted, Output: strings.Repeat("x", protocol.MaxTurnOutputBytes+1)}
	if err := j.Finish(result); !errors.Is(err, protocol.ErrTurnOutputLimit) {
		t.Fatalf("output overflow not rejected: %v", err)
	}
	entry, found, err := j.Lookup(cmd)
	if err != nil || !found || entry.Finished || entry.Result.Status == protocol.StatusCompleted {
		t.Fatalf("overflow recorded as completed: finished=%t found=%t err=%v", entry.Finished, found, err)
	}
}

func TestJournalPreservesMissingVersusRecordedEmptyOutput(t *testing.T) {
	for _, present := range []bool{false, true} {
		name := "missing"
		if present {
			name = "recorded-empty"
		}
		t.Run(name, func(t *testing.T) {
			dir := testPrivateDir(t)
			j, err := Open(dir, "result-output-scope")
			if err != nil {
				t.Fatal(err)
			}
			cmd := testCommand("command", "task")
			if _, created, err := j.Begin(cmd); err != nil || !created {
				t.Fatalf("begin: %v", err)
			}
			result := protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID,
				Status: protocol.StatusCompleted, TurnID: "target", OutputPresent: present}
			if err := j.Finish(result); err != nil {
				t.Fatal(err)
			}
			closeJournal(t, j)
			j, err = Open(dir, "result-output-scope")
			if err != nil {
				t.Fatal(err)
			}
			defer closeJournal(t, j)
			results, err := j.Unacked()
			if err != nil || len(results) != 1 || !protocol.SameResult(results[0], result) {
				t.Fatalf("unsafe replay: %+v %v", results, err)
			}
			data, err := json.Marshal(results[0])
			if err != nil {
				t.Fatal(err)
			}
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(data, &fields); err != nil {
				t.Fatal(err)
			}
			if _, exists := fields["output"]; exists != present {
				t.Fatalf("replay changed result presence: %s", data)
			}
			changed := result
			changed.OutputPresent = !present
			if err := j.Finish(changed); err == nil {
				t.Fatal("finalized output presence was mutable")
			}
			if err := j.Ack(protocol.ResultAckMessage{CommandID: cmd.CommandID, TurnID: "target", Status: protocol.StatusCompleted}); err != nil {
				t.Fatal(err)
			}
			entry, found, err := j.Lookup(cmd)
			if err != nil || !found || entry.Result.HasOutput() {
				t.Fatalf("ACK pruning invented an empty result: %+v %v", entry, err)
			}
		})
	}
}

func TestAcknowledgedRawEmptyPlaceholderIsNotARecordedResult(t *testing.T) {
	dir := testPrivateDir(t)
	j, err := Open(dir, "pruned-output-scope")
	if err != nil {
		t.Fatal(err)
	}
	cmd := testCommand("pruned-command", "task")
	// Raw persisted bytes represent an ACKed result after its body was pruned;
	// this must not depend on the current serializer omitting the placeholder.
	raw, err := json.Marshal(map[string]any{"fingerprint": fingerprint(cmd), "finished": true, "acknowledged": true,
		"result": map[string]any{"type": "result", "commandId": cmd.CommandID, "status": "completed", "turnId": "target", "output": ""}})
	if err != nil {
		t.Fatal(err)
	}
	if err := j.db.Update(func(tx *bolt.Tx) error { return tx.Bucket(recordsBucket).Put([]byte(cmd.CommandID), raw) }); err != nil {
		t.Fatal(err)
	}
	closeJournal(t, j)
	j, err = Open(dir, "pruned-output-scope")
	if err != nil {
		t.Fatal(err)
	}
	defer closeJournal(t, j)
	entry, found, err := j.Lookup(cmd)
	if err != nil || !found || entry.Result.HasOutput() || entry.Result.CommandID != cmd.CommandID || entry.Result.Status != protocol.StatusCompleted || entry.Result.TurnID != "target" {
		t.Fatalf("pruned body revived as empty: %+v %v", entry, err)
	}
	if repeated, created, err := j.Begin(cmd); err != nil || created || repeated.Result.HasOutput() {
		t.Fatalf("duplicate claim revived result: %+v created=%t error=%v", repeated, created, err)
	}
	if pending, err := j.Unacked(); err != nil || len(pending) != 0 {
		t.Fatalf("ACKed record resurrected in outbox: %+v %v", pending, err)
	}
	if err := j.db.View(func(tx *bolt.Tx) error {
		if string(tx.Bucket(recordsBucket).Get([]byte(cmd.CommandID))) != string(raw) {
			t.Error("read normalization mutated persisted bytes")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestAcknowledgedBodyIsAlwaysUnavailableRegardlessOfStoredText(t *testing.T) {
	cmd := testCommand("pruned-command", "task")
	for _, output := range []string{"", "previous recorded text"} {
		raw, err := json.Marshal(map[string]any{"fingerprint": fingerprint(cmd), "finished": true, "acknowledged": true,
			"result": map[string]any{"type": "result", "commandId": cmd.CommandID, "status": "completed", "turnId": "target",
				"output": output, "error": "previous error body"}})
		if err != nil {
			t.Fatal(err)
		}
		entry, err := decode([]byte(cmd.CommandID), raw)
		if err != nil || entry.Result.HasOutput() || entry.Result.Error != "" {
			t.Fatalf("ACKed body reappeared: %+v error=%v", entry, err)
		}
	}
}
