package client

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestHistoryCancelExactTupleDuplicateAndLate(t *testing.T) {
	d := NewDaemon(&config.Config{NodeID: "node"}, &historyFixture{})
	msg := routedHistoryRequest()
	ctx, cleanup, ok := d.historyRequests.register(context.Background(), msg)
	if !ok {
		t.Fatal("first request rejected")
	}
	defer cleanup()
	if _, _, ok := d.historyRequests.register(context.Background(), msg); ok {
		t.Fatal("duplicate active request accepted")
	}
	other := msg
	other.SessionID = "other"
	otherCtx, otherCleanup, ok := d.historyRequests.register(context.Background(), other)
	if !ok {
		t.Fatal("independent tuple rejected")
	}
	defer otherCleanup()
	cancelRequest := protocol.CancelHistoryMessage{Type: "cancel_history", RequestID: msg.RequestID, NodeID: msg.NodeID, SessionID: msg.SessionID}
	deliver := func(request protocol.CancelHistoryMessage) {
		t.Helper()
		data, err := json.Marshal(request)
		if err != nil {
			t.Fatal(err)
		}
		d.cancelHistory(data)
	}
	for _, field := range []string{"type", "node", "session", "request"} {
		wrong := cancelRequest
		switch field {
		case "type":
			wrong.Type = "command"
		case "node":
			wrong.NodeID = "other-node"
		case "session":
			wrong.SessionID = "missing"
		case "request":
			wrong.RequestID = "missing"
		}
		deliver(wrong)
		if ctx.Err() != nil || otherCtx.Err() != nil {
			t.Fatalf("wrong %s canceled a request", field)
		}
	}
	d.cancelHistory([]byte("invalid-json"))
	deliver(cancelRequest)
	deliver(cancelRequest)
	if ctx.Err() != context.Canceled || otherCtx.Err() != nil {
		t.Fatal("exact cancel missed target or canceled another target")
	}
	cleanup()
	deliver(cancelRequest)
	if otherCtx.Err() != nil || len(d.historyRequests.pending) != 1 {
		t.Fatal("late cancel changed another request")
	}
	otherCleanup()
	if len(d.historyRequests.pending) != 0 {
		t.Fatal("completed cancellation entry leaked")
	}
}

func TestScheduledHistoryCancelReleasesSlotWithoutReceipt(t *testing.T) {
	a := &historyFixture{started: make(chan struct{}, 1)}
	d := NewDaemon(&config.Config{NodeID: "node"}, a)
	msg := routedHistoryRequest()
	data, err := json.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	slots := make(chan struct{}, 1)
	var workers sync.WaitGroup
	sent := make(chan any, 1)
	failures := make(chan error, 1)
	if err := d.scheduleHistoryRead(context.Background(), data, slots, &workers, func(msg any) error { sent <- msg; return nil }, failures); err != nil {
		t.Fatal(err)
	}
	select {
	case <-a.started:
	case <-time.After(time.Second):
		t.Fatal("history did not start")
	}
	cancellation, err := json.Marshal(protocol.CancelHistoryMessage{Type: "cancel_history", RequestID: msg.RequestID, NodeID: msg.NodeID, SessionID: msg.SessionID})
	if err != nil {
		t.Fatal(err)
	}
	d.cancelHistory(cancellation)
	done := make(chan struct{})
	go func() { workers.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cancel did not release history worker")
	}
	if len(slots) != 0 || len(sent) != 0 || len(failures) != 0 || a.canceled.Load() != 1 || len(d.historyRequests.pending) != 0 || len(d.historyContexts.bindings) != 0 {
		t.Fatal("canceled history left workers, responses or registries")
	}
	if len(d.outbox) != 0 || len(d.dedupeCache) != 0 || len(d.inFlight) != 0 || len(d.sessionLocks) != 0 {
		t.Fatal("cancellation entered command bookkeeping")
	}
}
