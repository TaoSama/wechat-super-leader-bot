package journal

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	bolt "go.etcd.io/bbolt"
)

func TestTurnResultRearmsAcknowledgedAcceptanceAndSurvivesRestart(t *testing.T) {
	for _, acknowledged := range []bool{false, true} {
		name := "pending-accepted"
		if acknowledged {
			name = "acked-accepted"
		}
		t.Run(name, func(t *testing.T) {
			dir := testPrivateDir(t)
			j, err := Open(dir, "terminal-receipt-scope")
			if err != nil {
				t.Fatal(err)
			}
			cmd := testCommand("turn-command", "task")
			if _, _, err := j.Begin(cmd); err != nil {
				t.Fatal(err)
			}
			accepted := protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID, TurnID: "exact-turn", Status: protocol.StatusAccepted}
			if err := j.Finish(accepted); err != nil {
				t.Fatal(err)
			}
			if acknowledged {
				if err := j.Ack(protocol.ResultAckMessage{CommandID: cmd.CommandID, TurnID: accepted.TurnID, Status: accepted.Status}); err != nil {
					t.Fatal(err)
				}
			}
			completed := accepted
			completed.Status, completed.Output = protocol.StatusCompleted, "\n# 完整结果\n\n  Markdown  \n"
			if err := j.RecordTurnResult(cmd.SessionID, completed); err != nil {
				t.Fatal(err)
			}
			if err := j.RecordTurnResult(cmd.SessionID, completed); err != nil {
				t.Fatalf("identical terminal receipt must be idempotent: %v", err)
			}
			closeJournal(t, j)
			j, err = Open(dir, "terminal-receipt-scope")
			if err != nil {
				t.Fatal(err)
			}
			defer closeJournal(t, j)
			pending, err := j.Unacked()
			if err != nil || len(pending) != 1 || !protocol.SameResult(pending[0], completed) {
				t.Fatalf("terminal receipt not durably pending: count=%d err=%v", len(pending), err)
			}
			if err := j.Ack(protocol.ResultAckMessage{CommandID: cmd.CommandID, TurnID: accepted.TurnID, Status: accepted.Status}); err != nil {
				t.Fatal(err)
			}
			pending, err = j.Unacked()
			if err != nil || len(pending) != 1 {
				t.Fatalf("stale accepted ACK discarded terminal output: count=%d err=%v", len(pending), err)
			}
			changed := completed
			changed.Output = "different final"
			if err := j.RecordTurnResult(cmd.SessionID, changed); !errors.Is(err, ErrTurnResultIdentity) {
				t.Fatalf("terminal body changed: %v", err)
			}
		})
	}
}

func TestTurnResultRejectsWrongIdentityOrState(t *testing.T) {
	j, err := Open(testPrivateDir(t), "terminal-identity-scope")
	if err != nil {
		t.Fatal(err)
	}
	defer closeJournal(t, j)
	cmd := testCommand("turn-command", "task")
	if _, _, err := j.Begin(cmd); err != nil {
		t.Fatal(err)
	}
	accepted := protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID, TurnID: "exact-turn", Status: protocol.StatusAccepted}
	completed := accepted
	completed.Status, completed.Output = protocol.StatusCompleted, "full output"
	if err := j.RecordTurnResult(cmd.SessionID, completed); !errors.Is(err, ErrTurnResultIdentity) {
		t.Fatalf("unfinished claim accepted terminal output: %v", err)
	}
	if err := j.Finish(accepted); err != nil {
		t.Fatal(err)
	}
	if err := j.RecordTurnResult("another-session", completed); !errors.Is(err, ErrTurnResultIdentity) {
		t.Fatalf("wrong session accepted: %v", err)
	}
	for _, mutate := range []func(*protocol.DaemonResultMessage){
		func(result *protocol.DaemonResultMessage) { result.TurnID = "another-turn" },
		func(result *protocol.DaemonResultMessage) { result.Status = protocol.StatusAccepted },
		func(result *protocol.DaemonResultMessage) { result.Status = protocol.StatusUncertain },
		func(result *protocol.DaemonResultMessage) { result.Type = "other" },
	} {
		invalid := completed
		mutate(&invalid)
		if err := j.RecordTurnResult(cmd.SessionID, invalid); !errors.Is(err, ErrTurnResultIdentity) {
			t.Fatalf("invalid transition accepted: %v", err)
		}
	}
	entry, found, err := j.Lookup(cmd)
	if err != nil || !found || !protocol.SameResult(entry.Result, accepted) {
		t.Fatalf("invalid transition changed receipt: found=%t error=%v", found, err)
	}
}

func TestLegacyUnboundReceiptCannotAcquireNewSession(t *testing.T) {
	j, err := Open(testPrivateDir(t), "legacy-turn-scope")
	if err != nil {
		t.Fatal(err)
	}
	defer closeJournal(t, j)
	cmd := testCommand("legacy-command", "task")
	accepted := protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID, TurnID: "exact-turn", Status: protocol.StatusAccepted}
	raw, err := json.Marshal(Entry{Fingerprint: fingerprint(cmd), Finished: true, Result: accepted})
	if err != nil {
		t.Fatal(err)
	}
	if err := j.db.Update(func(tx *bolt.Tx) error {
		if err := tx.Bucket(recordsBucket).Put([]byte(cmd.CommandID), raw); err != nil {
			return err
		}
		return tx.Bucket(pendingBucket).Put([]byte(cmd.CommandID), []byte{1})
	}); err != nil {
		t.Fatal(err)
	}
	completed := accepted
	completed.Status = protocol.StatusCompleted
	if err := j.RecordTurnResult(cmd.SessionID, completed); !errors.Is(err, ErrTurnResultIdentity) {
		t.Fatalf("legacy missing session binding was guessed: %v", err)
	}
	entry, found, err := j.Lookup(cmd)
	if err != nil || !found || !protocol.SameResult(entry.Result, accepted) {
		t.Fatalf("legacy receipt must remain readable: found=%t error=%v", found, err)
	}
}
