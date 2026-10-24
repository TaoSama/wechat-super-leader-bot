package journal

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	bolt "go.etcd.io/bbolt"
)

func TestTurnResultAckRetainsOnlyDigestAndRejectsConflictingResults(t *testing.T) {
	for _, tc := range []struct {
		name   string
		result protocol.DaemonResultMessage
	}{
		{name: "completed-text", result: protocol.DaemonResultMessage{Status: protocol.StatusCompleted, Output: "完整结果\n"}},
		{name: "completed-empty", result: protocol.DaemonResultMessage{Status: protocol.StatusCompleted, OutputPresent: true}},
		{name: "completed-missing", result: protocol.DaemonResultMessage{Status: protocol.StatusCompleted}},
		{name: "failed-error", result: protocol.DaemonResultMessage{Status: protocol.StatusFailed, Error: "native failure"}},
		{name: "failed-replacement-character", result: protocol.DaemonResultMessage{Status: protocol.StatusFailed, Output: "\ufffd", Error: "\ufffd"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := testPrivateDir(t)
			const scope = "turn-ack-scope"
			j, err := Open(dir, scope)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if j != nil {
					closeJournal(t, j)
				}
			})
			cmd := testCommand("turn-command", "task")
			if _, created, err := j.Begin(cmd); err != nil || !created {
				t.Fatalf("begin: created=%t error=%v", created, err)
			}
			accepted := protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID, TurnID: "exact-turn", Status: protocol.StatusAccepted}
			if err := j.Finish(accepted); err != nil {
				t.Fatal(err)
			}
			// An acknowledged acceptance must still advance and shed its old digest.
			if err := j.Ack(protocol.ResultAckMessage{CommandID: cmd.CommandID, TurnID: accepted.TurnID, Status: accepted.Status}); err != nil {
				t.Fatal(err)
			}
			result := tc.result
			result.Type, result.CommandID, result.TurnID = accepted.Type, accepted.CommandID, accepted.TurnID
			if err := j.RecordTurnResult(cmd.SessionID, result); err != nil {
				t.Fatal(err)
			}
			for _, stage := range []string{"before-ack", "after-ack", "after-restart"} {
				if stage == "after-ack" {
					if err := j.Ack(protocol.ResultAckMessage{CommandID: cmd.CommandID, TurnID: result.TurnID, Status: result.Status}); err != nil {
						t.Fatal(err)
					}
				}
				if stage == "after-restart" {
					closeJournal(t, j)
					j = nil
					j, err = Open(dir, scope)
					if err != nil {
						t.Fatal(err)
					}
				}
				var stored Entry
				var original []byte
				if err := j.db.View(func(tx *bolt.Tx) error {
					original = append([]byte(nil), tx.Bucket(recordsBucket).Get([]byte(cmd.CommandID))...)
					return json.Unmarshal(original, &stored)
				}); err != nil {
					t.Fatal(err)
				}
				acked := stage != "before-ack"
				if stored.Acknowledged != acked || (acked && (stored.Result.HasOutput() || stored.Result.Error != "" || len(stored.ResultSHA256) != sha256.Size*2)) ||
					(!acked && (stored.ResultSHA256 != "" || !protocol.SameResult(stored.Result, result))) {
					t.Fatalf("%s persisted wrong receipt/body state", stage)
				}
				if err := j.RecordTurnResult(cmd.SessionID, result); err != nil {
					t.Fatalf("%s exact receipt rejected: %v", stage, err)
				}
				if result.Output != "" {
					equivalent := result
					equivalent.OutputPresent = !result.OutputPresent
					if err := j.RecordTurnResult(cmd.SessionID, equivalent); err != nil {
						t.Fatalf("%s canonical output presence changed receipt identity: %v", stage, err)
					}
				}
				for _, mutate := range []func(*protocol.DaemonResultMessage){
					func(r *protocol.DaemonResultMessage) { r.Output = "different output" },
					func(r *protocol.DaemonResultMessage) { r.Error += "different error" },
					func(r *protocol.DaemonResultMessage) {
						if r.Status == protocol.StatusCompleted {
							r.Status = protocol.StatusFailed
						} else {
							r.Status = protocol.StatusCompleted
						}
					},
					func(r *protocol.DaemonResultMessage) { r.TurnID = "different-turn" },
					func(r *protocol.DaemonResultMessage) { r.InputReceipt = &protocol.InputReceipt{} },
				} {
					conflicting := result
					mutate(&conflicting)
					if err := j.RecordTurnResult(cmd.SessionID, conflicting); !errors.Is(err, ErrTurnResultIdentity) {
						t.Fatalf("%s conflicting receipt was not rejected: %v", stage, err)
					}
				}
				for _, mutate := range []func(*protocol.DaemonResultMessage){
					func(r *protocol.DaemonResultMessage) { r.Output = string([]byte{0xff}) },
					func(r *protocol.DaemonResultMessage) { r.Error = string([]byte{0xff}) },
				} {
					conflicting := result
					mutate(&conflicting)
					if err := j.RecordTurnResult(cmd.SessionID, conflicting); err == nil {
						t.Fatalf("%s invalid UTF-8 was normalized into a matching receipt", stage)
					}
				}
				if result.Output == "" {
					conflicting := result
					conflicting.OutputPresent = !result.OutputPresent
					if err := j.RecordTurnResult(cmd.SessionID, conflicting); !errors.Is(err, ErrTurnResultIdentity) {
						t.Fatalf("%s missing/empty output conflict was not rejected: %v", stage, err)
					}
				}
				if err := j.RecordTurnResult("different-session", result); !errors.Is(err, ErrTurnResultIdentity) {
					t.Fatalf("%s wrong session was not rejected: %v", stage, err)
				}
				if err := j.db.View(func(tx *bolt.Tx) error {
					if string(tx.Bucket(recordsBucket).Get([]byte(cmd.CommandID))) != string(original) {
						t.Errorf("%s duplicate/conflict mutated the durable receipt", stage)
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
				pending, err := j.Unacked()
				if err != nil || (acked && len(pending) != 0) || (!acked && len(pending) != 1) {
					t.Fatalf("%s unexpected pending receipt count=%d error=%v", stage, len(pending), err)
				}
				t.Logf("%s exactReceipt=true conflictsRejected=true durableBytesUnchanged=true pending=%d", stage, len(pending))
			}
		})
	}
}

func TestAcknowledgedResultDigestMustBeValid(t *testing.T) {
	cmd := testCommand("digest-command", "task")
	for _, digest := range []string{"not-a-digest", "00"} {
		entry := Entry{Fingerprint: fingerprint(cmd), Finished: true, Acknowledged: true, ResultSHA256: digest,
			Result: protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID, Status: protocol.StatusCompleted}}
		raw, err := json.Marshal(entry)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := decode([]byte(cmd.CommandID), raw); err == nil {
			t.Fatal("malformed acknowledged result digest was accepted")
		}
	}
}

func TestAcknowledgedLegacyTurnWithoutDigestCannotClaimBodyEquality(t *testing.T) {
	j, err := Open(testPrivateDir(t), "legacy-acked-turn-scope")
	if err != nil {
		t.Fatal(err)
	}
	defer closeJournal(t, j)
	cmd := testCommand("legacy-command", "task")
	result := protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID, TurnID: "exact-turn", Status: protocol.StatusCompleted}
	raw, err := json.Marshal(Entry{Fingerprint: fingerprint(cmd), SessionID: cmd.SessionID, Finished: true, Acknowledged: true, Result: result})
	if err != nil {
		t.Fatal(err)
	}
	if err := j.db.Update(func(tx *bolt.Tx) error { return tx.Bucket(recordsBucket).Put([]byte(cmd.CommandID), raw) }); err != nil {
		t.Fatal(err)
	}
	if err := j.RecordTurnResult(cmd.SessionID, result); !errors.Is(err, ErrTurnResultIdentity) {
		t.Fatalf("legacy pruned placeholder was treated as a matching body: %v", err)
	}
	if entry, found, err := j.Lookup(cmd); err != nil || !found || !entry.Acknowledged || entry.Result.HasOutput() {
		t.Fatalf("legacy acknowledged receipt no longer readable: found=%t error=%v", found, err)
	}
}
