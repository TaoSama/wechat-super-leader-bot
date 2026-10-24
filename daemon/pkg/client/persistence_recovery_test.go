package client

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/gorilla/websocket"
)

type ackReleasedJournal struct {
	commandJournal
	blockedID      string
	releasedBy     protocol.ControllerCommandMessage
	released       atomic.Bool
	finishFailures atomic.Int32
}

func (j *ackReleasedJournal) Finish(result protocol.DaemonResultMessage) error {
	if result.CommandID == j.blockedID && !j.released.Load() {
		j.finishFailures.Add(1)
		return errors.New("fixture journal capacity reached")
	}
	return j.commandJournal.Finish(result)
}

func (j *ackReleasedJournal) Ack(ack protocol.ResultAckMessage) error {
	if err := j.commandJournal.Ack(ack); err != nil {
		return err
	}
	if ack.CommandID != j.releasedBy.CommandID {
		return nil
	}
	entry, found, err := j.commandJournal.Lookup(j.releasedBy)
	if err != nil {
		return err
	}
	if found && entry.Acknowledged && !entry.Result.HasOutput() {
		j.released.Store(true)
	}
	return nil
}

func TestPendingFinishFailureDoesNotBlockOtherReceipts(t *testing.T) {
	d, err := OpenDaemon(persistenceConfig(t.TempDir()), &receiptAdapter{})
	if err != nil {
		t.Fatal(err)
	}
	defer closeDaemon(t, d)
	expiry := time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)
	commands := make(map[string]protocol.ControllerCommandMessage)
	for _, id := range []string{"durable", "blocked", "retryable"} {
		cmd := persistenceCommand(expiry)
		cmd.CommandID = id
		commands[id] = cmd
		if _, created, err := d.journal.Begin(cmd); err != nil || !created {
			t.Fatalf("claim %s: created=%t error=%v", id, created, err)
		}
		result := protocol.DaemonResultMessage{Type: "result", CommandID: id, Status: protocol.StatusCompleted, Output: id}
		if id == "durable" {
			if err := d.journal.Finish(result); err != nil {
				t.Fatal(err)
			}
		} else {
			d.pendingPersistence[id] = result
		}
	}
	d.journal = &ackReleasedJournal{commandJournal: d.journal, blockedID: "blocked", releasedBy: commands["durable"]}
	sent := make(map[string]protocol.DaemonResultMessage)
	if err := d.flushResults(func(value any) error {
		result := value.(protocol.DaemonResultMessage)
		sent[result.CommandID] = result
		return nil
	}); err != nil {
		t.Fatalf("one pending Finish stopped durable replay: %v", err)
	}
	if len(sent) != 2 || sent["durable"].Output != "durable" || sent["retryable"].Output != "retryable" {
		t.Fatalf("durable or independently retryable receipt missing: %+v", sent)
	}
	if len(d.pendingPersistence) != 1 || d.pendingPersistence["blocked"].Output != "blocked" {
		t.Fatal("blocked result was lost or successful retry remained pending")
	}
	entry, found, err := d.journal.Lookup(commands["blocked"])
	if err != nil || !found || entry.Finished {
		t.Fatalf("failed Finish changed the durable claim: found=%t finished=%t error=%v", found, entry.Finished, err)
	}
	if err := d.flushResults(func(any) error { return errors.New("fixture transport unavailable") }); err == nil {
		t.Fatal("transport failure was hidden by the pending persistence failure")
	}
}

func TestReconnectReplaysDurableReceiptsUntilAckReleasesPendingFinish(t *testing.T) {
	const timeout = 5 * time.Second
	const heartbeatInterval = 10 * time.Millisecond
	const oldID, pendingID, barrierID = "old-durable", "pending-finish", "ack-barrier"
	adapter := &receiptAdapter{}
	expiry := time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)
	oldCommand, pendingCommand := persistenceCommand(expiry), persistenceCommand(expiry)
	oldCommand.CommandID, pendingCommand.CommandID = oldID, pendingID
	oldResult := protocol.DaemonResultMessage{Type: "result", CommandID: oldID, Status: protocol.StatusCompleted, Output: strings.Repeat("previous durable output", 1024)}
	var connections atomic.Int32
	done := make(chan error, 2)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			done <- err
			return
		}
		defer func() {
			if err := conn.Close(); err != nil {
				t.Logf("fixture connection cleanup: %v", err)
			}
		}()
		attempt := connections.Add(1)
		if err := conn.SetReadDeadline(time.Now().Add(timeout)); err != nil {
			done <- err
			return
		}
		var hello protocol.DaemonHelloMessage
		if err := conn.ReadJSON(&hello); err != nil {
			done <- err
			return
		}
		if hello.Type != "hello" || attempt > 2 {
			done <- fmt.Errorf("unexpected recovery connection: type=%s attempt=%d", hello.Type, attempt)
			return
		}
		readResult := func(id string) (protocol.DaemonResultMessage, error) {
			for {
				var result protocol.DaemonResultMessage
				if err := conn.ReadJSON(&result); err != nil {
					return result, err
				}
				if result.Type == "result" && result.CommandID == id {
					return result, nil
				}
			}
		}
		replay, err := readResult(oldID)
		if err != nil || !protocol.SameResult(replay, oldResult) {
			done <- fmt.Errorf("previous durable receipt not replayed: error=%v", err)
			return
		}
		if attempt == 1 {
			return // Force a real reconnect before the first durable ACK.
		}
		if err := conn.WriteJSON(protocol.ResultAckMessage{Type: "result_ack", CommandID: oldID, Status: oldResult.Status}); err != nil {
			done <- err
			return
		}
		pending, err := readResult(pendingID)
		if err != nil || pending.Status != protocol.StatusAccepted || pending.TurnID != "durable-turn" {
			done <- fmt.Errorf("pending Finish did not recover after ACK: status=%s error=%v", pending.Status, err)
			return
		}
		if err := conn.WriteJSON(protocol.ResultAckMessage{Type: "result_ack", CommandID: pendingID, Status: pending.Status, TurnID: pending.TurnID}); err != nil {
			done <- err
			return
		}
		barrier := pendingCommand
		barrier.Type, barrier.CommandID = "inspect_command", barrierID
		if err := conn.WriteJSON(barrier); err != nil {
			done <- err
			return
		}
		if _, err := readResult(barrierID); err != nil {
			done <- err
			return
		}
		done <- nil
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer server.Close()
	cfg := persistenceConfig(t.TempDir())
	cfg.ControllerURL, cfg.HeartbeatInterval = "ws"+strings.TrimPrefix(server.URL, "http"), heartbeatInterval
	d, err := OpenDaemon(cfg, adapter)
	if err != nil {
		t.Fatal(err)
	}
	defer closeDaemon(t, d)
	if _, created, err := d.journal.Begin(oldCommand); err != nil || !created {
		t.Fatalf("old claim: created=%t error=%v", created, err)
	}
	if err := d.journal.Finish(oldResult); err != nil {
		t.Fatal(err)
	}
	capacity := &ackReleasedJournal{commandJournal: d.journal, blockedID: pendingID, releasedBy: oldCommand}
	d.journal = capacity
	if result := d.ExecuteCommand(context.Background(), pendingCommand); result.Status != protocol.StatusUncertain || adapter.sends.Load() != 1 {
		t.Fatalf("expected retained result after failed Finish: status=%s sends=%d", result.Status, adapter.sends.Load())
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	exited := make(chan error, 1)
	go func() { exited <- d.Run(ctx) }()
	defer func() {
		cancel()
		select {
		case err := <-exited:
			if !errors.Is(err, context.Canceled) {
				t.Errorf("unexpected daemon exit: %v", err)
			}
		case <-time.After(time.Second):
			t.Error("daemon recovery workers did not stop")
		}
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("pending Finish prevented durable replay, ACK processing, or retry")
	}
	if unacked, err := d.journal.Unacked(); err != nil || len(unacked) != 0 {
		t.Fatalf("recovery receipts not acknowledged: count=%d error=%v", len(unacked), err)
	}
	d.persistenceMu.Lock()
	pendingCount := len(d.pendingPersistence)
	d.persistenceMu.Unlock()
	if pendingCount != 0 || !capacity.released.Load() || capacity.finishFailures.Load() < 3 || connections.Load() != 2 {
		t.Fatalf("incomplete recovery: pending=%d released=%t failedFinishes=%d connections=%d", pendingCount, capacity.released.Load(), capacity.finishFailures.Load(), connections.Load())
	}
	for _, cmd := range []protocol.ControllerCommandMessage{oldCommand, pendingCommand} {
		entry, found, err := d.journal.Lookup(cmd)
		if err != nil || !found || !entry.Finished || !entry.Acknowledged || entry.Result.HasOutput() {
			t.Fatalf("ACK did not prune body and retain guard: found=%t finished=%t acknowledged=%t error=%v", found, entry.Finished, entry.Acknowledged, err)
		}
		d.ExecuteCommand(context.Background(), cmd)
	}
	if adapter.sends.Load() != 1 {
		t.Fatalf("recovery replayed an already claimed command: sends=%d", adapter.sends.Load())
	}
	t.Logf("connections=%d failedFinishes=%d pending=%d unacked=0 adapterDispatches=%d", connections.Load(), capacity.finishFailures.Load(), pendingCount, adapter.sends.Load())
}
