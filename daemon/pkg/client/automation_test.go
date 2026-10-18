package client

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestAutomationReadValidatesNodeRangeAndNeverDispatchesCommands(t *testing.T) {
	d := NewDaemon(&config.Config{NodeID: "node"}, &historyFixture{})
	for _, request := range []automationRequest{
		{Type: "inspect_automation", RequestID: "req", NodeID: "other", AutomationID: "daily", ExpectedAt: 1000, NotAfter: 2000},
		{Type: "inspect_automation", RequestID: "req", NodeID: "node", AutomationID: "../bad", ExpectedAt: 1000, NotAfter: 2000},
		{Type: "inspect_automation", RequestID: "req", NodeID: "node", AutomationID: "daily", ExpectedAt: 2000, NotAfter: 1000},
	} {
		data, err := json.Marshal(request)
		if err != nil {
			t.Fatal(err)
		}
		var response automationResponse
		var workers sync.WaitGroup
		if err = d.scheduleAutomationRead(context.Background(), data, make(chan struct{}, 1), &workers, func(value any) error { response = value.(automationResponse); return nil }, make(chan error, 1)); err != nil {
			t.Fatal(err)
		}
		workers.Wait()
		if response.Error != "automation_invalid_request" {
			t.Fatalf("invalid request accepted: %+v", response)
		}
	}
	if len(d.outbox) != 0 || len(d.dedupeCache) != 0 || len(d.inFlight) != 0 || len(d.sessionLocks) != 0 {
		t.Fatal("read entered command bookkeeping")
	}
}
func TestAutomationCancellationBindsAuthenticatedNodeAndRequest(t *testing.T) {
	d := NewDaemon(&config.Config{NodeID: "node"}, &historyFixture{})
	ctx, cleanup, ok := d.historyRequests.register(context.Background(), protocol.ReadHistoryMessage{RequestID: "request", NodeID: "node", SessionID: "automation"})
	if !ok {
		t.Fatal("registration failed")
	}
	defer cleanup()
	other, otherCleanup, ok := d.historyRequests.register(context.Background(), protocol.ReadHistoryMessage{RequestID: "other", NodeID: "node", SessionID: "automation"})
	if !ok {
		t.Fatal("other registration failed")
	}
	defer otherCleanup()
	deliver := func(node, id string) {
		t.Helper()
		data, err := json.Marshal(automationRequest{Type: "cancel_automation", NodeID: node, RequestID: id})
		if err != nil {
			t.Fatal(err)
		}
		d.cancelAutomation(data)
	}
	deliver("other-node", "request")
	if ctx.Err() != nil {
		t.Fatal("other node canceled read")
	}
	deliver("node", "request")
	if ctx.Err() != context.Canceled || other.Err() != nil {
		t.Fatal("cancellation affected wrong read")
	}
}
func TestAutomationReadsReportBusyWithoutSpawning(t *testing.T) {
	d := NewDaemon(&config.Config{NodeID: "node"}, &historyFixture{})
	slots := make(chan struct{}, 1)
	slots <- struct{}{}
	var workers sync.WaitGroup
	request := automationRequest{Type: "list_automations", RequestID: "request", NodeID: "node"}
	data, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	var response automationResponse
	if err = d.scheduleAutomationRead(context.Background(), data, slots, &workers, func(value any) error { response = value.(automationResponse); return nil }, make(chan error, 1)); err != nil {
		t.Fatal(err)
	}
	workers.Wait()
	if response.Error != "automation_busy" {
		t.Fatalf("wrong response %+v", response)
	}
	if len(d.historyRequests.pending) != 0 {
		t.Fatal("busy read left request")
	}
}
