package journal

import (
	"errors"
	"strings"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	berrors "go.etcd.io/bbolt/errors"
)

func TestJournalCapacityFailureRecoversAfterAcknowledgedBodyIsPruned(t *testing.T) {
	const maxDatabaseBytes = 1024 * 1024
	const outputBytes = 64 * 1024
	j, err := Open(testPrivateDir(t), "capacity-recovery-scope")
	if err != nil {
		t.Fatal(err)
	}
	defer closeJournal(t, j)
	j.db.MaxSize = maxDatabaseBytes
	oldCommand, pendingCommand := testCommand("old-result", "old"), testCommand("pending-result", "pending")
	for _, cmd := range []protocol.ControllerCommandMessage{oldCommand, pendingCommand} {
		if _, created, err := j.Begin(cmd); err != nil || !created {
			t.Fatalf("claim %s: created=%t error=%v", cmd.CommandID, created, err)
		}
	}
	old := protocol.DaemonResultMessage{Type: "result", CommandID: oldCommand.CommandID, Status: protocol.StatusCompleted, Output: strings.Repeat("<", outputBytes)}
	pending := old
	pending.CommandID = pendingCommand.CommandID
	if err := j.Finish(old); err != nil {
		t.Fatalf("persist previous body: %v", err)
	}
	if err := j.Finish(pending); !errors.Is(err, berrors.ErrMaxSizeReached) {
		t.Fatalf("expected a real bbolt capacity failure after successful Begin: %v", err)
	}
	entry, found, err := j.Lookup(pendingCommand)
	if err != nil || !found || entry.Finished {
		t.Fatalf("failed Finish discarded or finalized claim: found=%t finished=%t error=%v", found, entry.Finished, err)
	}
	if unacked, err := j.Unacked(); err != nil || len(unacked) != 1 || !protocol.SameResult(unacked[0], old) {
		t.Fatalf("capacity failure lost the previous receipt: count=%d error=%v", len(unacked), err)
	}
	if err := j.Ack(protocol.ResultAckMessage{Type: "result_ack", CommandID: old.CommandID, Status: old.Status}); err != nil {
		t.Fatalf("prune previous body: %v", err)
	}
	if err := j.Finish(pending); err != nil {
		t.Fatalf("retry did not reuse pages released by ACK: %v", err)
	}
	if unacked, err := j.Unacked(); err != nil || len(unacked) != 1 || !protocol.SameResult(unacked[0], pending) {
		t.Fatalf("recovered result missing or changed: count=%d error=%v", len(unacked), err)
	}
	for _, cmd := range []protocol.ControllerCommandMessage{oldCommand, pendingCommand} {
		if entry, created, err := j.Begin(cmd); err != nil || created || !entry.Finished {
			t.Fatalf("capacity recovery reopened dispatch claim: created=%t finished=%t error=%v", created, entry.Finished, err)
		}
	}
	t.Logf("maxDatabaseBytes=%d outputBytes=%d Begin=success Finish=ErrMaxSizeReached ACK=success retry=success", maxDatabaseBytes, outputBytes)
}
