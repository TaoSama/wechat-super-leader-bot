package client

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	retentionReadCount   = 16
	retentionOutputBytes = 1024 * 1024
)

type cacheRetentionAdapter struct {
	receiptAdapter
	reads int
}

func (a *cacheRetentionAdapter) ReadSession(context.Context, string) (string, error) {
	a.reads++
	return fmt.Sprintf("read %d\n", a.reads) + strings.Repeat("x", retentionOutputBytes), nil
}

func TestDurableReadAcknowledgementDoesNotRetainVolatileBodies(t *testing.T) {
	cfg := persistenceConfig(t.TempDir())
	adapter := &cacheRetentionAdapter{}
	d, err := OpenDaemon(cfg, adapter)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if d != nil {
			closeDaemon(t, d)
		}
	})
	var lastCommand protocol.ControllerCommandMessage
	for i := range retentionReadCount {
		cmd := persistenceCommand(time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano))
		cmd.CommandID = fmt.Sprintf("large-read-%d", i)
		cmd.Action, cmd.Prompt = protocol.ActionRead, ""
		result := d.ExecuteCommand(context.Background(), cmd)
		if result.Status != protocol.StatusCompleted || len(result.Output) < retentionOutputBytes {
			t.Fatalf("read did not preserve original output: status=%s bytes=%d", result.Status, len(result.Output))
		}
		if duplicate := d.ExecuteCommand(context.Background(), cmd); !protocol.SameResult(result, duplicate) || adapter.reads != i+1 {
			t.Fatal("unacknowledged duplicate did not replay exact journal receipt")
		}
		if len(d.dedupeCache) != 0 || len(d.dedupeOrder) != 0 || len(d.pendingPersistence) != 0 {
			t.Fatal("durable execution retained a redundant in-memory receipt")
		}
		if err := d.ackResult(protocol.ResultAckMessage{CommandID: cmd.CommandID, Status: protocol.StatusFailed}); err != nil {
			t.Fatal(err)
		}
		entry, found, err := d.journal.Lookup(cmd)
		if err != nil || !found || entry.Result.Output != result.Output {
			t.Fatal("mismatching ACK lost the durable body")
		}
		if err := d.ackResult(protocol.ResultAckMessage{CommandID: cmd.CommandID, Status: result.Status}); err != nil {
			t.Fatal(err)
		}
		if duplicate := d.ExecuteCommand(context.Background(), cmd); duplicate.Status != result.Status || duplicate.HasOutput() || adapter.reads != i+1 {
			t.Fatal("ACK erased dedupe protection or revived acknowledged output")
		}
		conflict := cmd
		conflict.SessionID = "different-session"
		if got := d.ExecuteCommand(context.Background(), conflict); got.Status != protocol.StatusUncertain || adapter.reads != i+1 {
			t.Fatal("conflicting duplicate reached the adapter")
		}
		lastCommand = cmd
	}
	if pending, err := d.journal.Unacked(); err != nil || len(pending) != 0 {
		t.Fatalf("acknowledged backlog remains: count=%d err=%v", len(pending), err)
	}
	retainedOutputBytes := 0
	for _, cached := range d.dedupeCache {
		retainedOutputBytes += len(cached.result.Output)
	}
	if len(d.dedupeCache) != 0 || len(d.dedupeOrder) != 0 || len(d.pendingPersistence) != 0 {
		t.Fatalf("durable results remain in volatile caches: entries=%d order=%d pending=%d retainedOutputBytes=%d",
			len(d.dedupeCache), len(d.dedupeOrder), len(d.pendingPersistence), retainedOutputBytes)
	}
	t.Logf("ACKed reads=%d retainedOutputBytes=%d volatileEntries=%d pendingPersistence=%d",
		retentionReadCount, retainedOutputBytes, len(d.dedupeCache), len(d.pendingPersistence))
	closeDaemon(t, d)
	d, err = OpenDaemon(cfg, adapter)
	if err != nil {
		t.Fatal(err)
	}
	if got := d.ExecuteCommand(context.Background(), lastCommand); got.Status != protocol.StatusCompleted || got.HasOutput() || adapter.reads != retentionReadCount {
		t.Fatal("restart lost acknowledged replay protection")
	}
}

func TestVolatileAcknowledgementPrunesBodyAndPreservesReplayGuard(t *testing.T) {
	adapter := &cacheRetentionAdapter{}
	d := NewDaemon(persistenceConfig(t.TempDir()), adapter)
	cmd := persistenceCommand(time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano))
	cmd.Action, cmd.Prompt = protocol.ActionRead, ""
	if !d.reserveResult(cmd.CommandID) {
		t.Fatal("result reservation failed")
	}
	result := d.ExecuteCommand(context.Background(), cmd)
	d.queueResult(result)
	if result.Status != protocol.StatusCompleted || len(result.Output) < retentionOutputBytes {
		t.Fatal("missing full read result")
	}
	if err := d.ackResult(protocol.ResultAckMessage{CommandID: cmd.CommandID, Status: protocol.StatusFailed}); err != nil {
		t.Fatal(err)
	}
	cached, found := d.checkDedupe(cmd.CommandID)
	if !found || cached.result.Output != result.Output || d.outbox[cmd.CommandID].Output != result.Output {
		t.Fatal("incorrect ACK removed an unacknowledged body")
	}
	replays := 0
	if err := d.flushResults(func(msg any) error {
		replays++
		if !protocol.SameResult(msg.(protocol.DaemonResultMessage), result) {
			t.Error("unacknowledged replay changed the original body")
		}
		return nil
	}); err != nil || replays != 1 {
		t.Fatalf("full replay failed: replays=%d err=%v", replays, err)
	}
	if err := d.ackResult(protocol.ResultAckMessage{CommandID: cmd.CommandID, Status: result.Status}); err != nil {
		t.Fatal(err)
	}
	cached, found = d.checkDedupe(cmd.CommandID)
	if !found || cached.result.HasOutput() || cached.result.Error != "" || cached.fingerprint != cmd.PayloadFingerprint() || len(d.outbox) != 0 {
		t.Fatal("ACK retained the body or lost replay identity")
	}
	if duplicate := d.ExecuteCommand(context.Background(), cmd); duplicate.Status != result.Status || duplicate.HasOutput() || adapter.reads != 1 {
		t.Fatal("ACKed command executed again or fabricated empty output")
	}
	cmd.SessionID = "conflicting-session"
	if duplicate := d.ExecuteCommand(context.Background(), cmd); duplicate.Status != protocol.StatusFailed || adapter.reads != 1 {
		t.Fatal("conflicting duplicate executed after ACK")
	}
}
