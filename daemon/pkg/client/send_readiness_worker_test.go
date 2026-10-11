package client

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/skills"
)

const readinessWorkerTestTimeout = 3 * time.Second

func awaitReadinessWorker(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(readinessWorkerTestTimeout):
		t.Fatal("readiness worker did not join")
	}
}

func TestBlockedReadinessIsBoundedIndependentAndCancellationJoins(t *testing.T) {
	d := newReadinessFixture(t)
	now := time.Now()
	updates := make(chan struct{}, 1)
	sessions := []protocol.Session{{ID: "one"}, {ID: "two"}, {ID: "three"}, {ID: "four"}}
	d.sessionSnapshot = cloneSessions(sessions)
	for _, session := range sessions {
		d.publishDesktop(session.ID, idleReadinessObservation(now, 1), updates)
	}
	calls := make(chan string, len(sessions))
	var active, maximum, stopped atomic.Int32
	checker := &readinessFixtureController{check: func(ctx context.Context, id string) error {
		current := active.Add(1)
		for old := maximum.Load(); current > old && !maximum.CompareAndSwap(old, current); old = maximum.Load() {
		}
		calls <- id
		<-ctx.Done()
		active.Add(-1)
		stopped.Add(1)
		return ctx.Err()
	}}
	d.desktopController = checker
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); d.refreshSendReadiness(ctx, updates) }()
	t.Cleanup(func() { cancel(); awaitReadinessWorker(t, done) })
	for range readinessConcurrency {
		select {
		case <-calls:
		case <-time.After(readinessWorkerTestTimeout):
			t.Fatal("idle owner was not probed")
		}
	}
	select {
	case id := <-calls:
		t.Fatalf("more than two simultaneous probes: %s", id)
	case <-time.After(2 * readinessTick):
	}
	var discoveries atomic.Int32
	d.adapter = &refreshFixture{discover: func(context.Context) ([]protocol.Session, error) {
		discoveries.Add(1)
		return cloneSessions(sessions), nil
	}}
	d.refreshControlSnapshot(ctx, updates)
	if discoveries.Load() != 1 {
		t.Fatal("blocked readiness blocked native discovery")
	}
	d.cfg.HeartbeatInterval = 10 * time.Millisecond
	heartbeats := make(chan protocol.DaemonHeartbeatMessage, 1)
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		err := d.heartbeatLoop(ctx, updates, make(chan struct{}, 1), func() []skills.Skill { return nil }, func(value any) error {
			if message, ok := value.(protocol.DaemonHeartbeatMessage); ok {
				select {
				case heartbeats <- message:
				default:
				}
			}
			return nil
		})
		if err != nil {
			t.Errorf("heartbeat failed: %v", err)
		}
	}()
	t.Cleanup(func() { cancel(); awaitReadinessWorker(t, heartbeatDone) })
	select {
	case message := <-heartbeats:
		if len(message.Sessions) != len(sessions) || message.Sessions[0].SendAvailability == nil || message.Sessions[0].SendAvailability.State == protocol.SendReady {
			t.Fatalf("heartbeat omitted checking or forged ready: %+v", message)
		}
	case <-time.After(readinessWorkerTestTimeout):
		t.Fatal("blocked readiness stalled heartbeat")
	}
	cancel()
	awaitReadinessWorker(t, done)
	awaitReadinessWorker(t, heartbeatDone)
	if maximum.Load() != readinessConcurrency || stopped.Load() != readinessConcurrency || active.Load() != 0 || checker.prepares.Load() != 0 || checker.sends.Load() != 0 {
		t.Fatalf("unsafe worker lifecycle: maximum=%d stopped=%d active=%d prepares=%d sends=%d", maximum.Load(), stopped.Load(), active.Load(), checker.prepares.Load(), checker.sends.Load())
	}
	for _, session := range d.cachedSessions() {
		if session.SendAvailability == nil || session.SendAvailability.State != protocol.SendUnavailable {
			t.Fatal("shutdown lost known desktop route or retained readiness")
		}
	}
}

func TestReadinessLateProbeCannotSurviveDisconnectAndReconnectedIdle(t *testing.T) {
	d := newReadinessFixture(t)
	updates := make(chan struct{}, 1)
	initial := idleReadinessObservation(time.Now(), 1)
	id := "fixture-session"
	d.publishDesktop(id, initial, updates)
	started := make(chan struct{})
	release := make(chan struct{})
	var count atomic.Int32
	d.desktopController = &readinessFixtureController{check: func(ctx context.Context, _ string) error {
		count.Add(1)
		close(started)
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); d.refreshSendReadiness(ctx, updates) }()
	t.Cleanup(func() { cancel(); awaitReadinessWorker(t, done) })
	awaitReadinessWorker(t, started)
	stamp := d.cachedSessions()[0].SendAvailability.ObservedAt
	// Simulate the observer's normal thirty-second window ending, followed by
	// a new idle snapshot from the same owner with the same revision.
	d.invalidateDesktop(updates)
	initial.ObservedAt = time.Now().UTC().Format(time.RFC3339Nano)
	d.publishDesktop(id, initial, updates)
	close(release)
	deadline := time.Now().Add(readinessWorkerTestTimeout)
	for {
		d.snapshotMu.RLock()
		record := d.sendReadiness[id]
		d.snapshotMu.RUnlock()
		if !record.NextCheck.IsZero() {
			if record.Availability.State == protocol.SendReady || record.Availability.ObservedAt != stamp || count.Load() != 1 {
				t.Fatalf("late probe escaped disconnect generation: %+v checks=%d", record, count.Load())
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("late probe did not finish")
		}
		time.Sleep(time.Millisecond)
	}
	if got := d.readinessSweep(time.Now(), map[string]bool{}, 2, updates); len(got) != 0 {
		t.Fatal("disconnect immediately restarted completed probe")
	}
}

func TestReadinessWorkerSuccessIsSingleFlightAndDoesNotClaimCommand(t *testing.T) {
	d := newReadinessFixture(t)
	updates := make(chan struct{}, 1)
	d.publishDesktop("fixture-session", idleReadinessObservation(time.Now(), 1), updates)
	var count atomic.Int32
	d.desktopController = &readinessFixtureController{check: func(context.Context, string) error { count.Add(1); return nil }}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); d.refreshSendReadiness(ctx, updates) }()
	t.Cleanup(func() { cancel(); awaitReadinessWorker(t, done) })
	deadline := time.Now().Add(readinessWorkerTestTimeout)
	for d.cachedSessions()[0].SendAvailability.State != protocol.SendReady {
		if time.Now().After(deadline) {
			t.Fatal("complete read-only probe did not grant ready")
		}
		time.Sleep(time.Millisecond)
	}
	time.Sleep(2 * readinessTick)
	if count.Load() != 1 {
		t.Fatal("successful probe repeated before thirty seconds")
	}
	cmd := desktopCommand()
	if _, found, err := d.journal.Lookup(cmd); err != nil || found {
		t.Fatalf("readiness probe created durable command: found=%t err=%v", found, err)
	}
}

func TestDesktopSendFlagBlocksMutationButPreservesExactInspection(t *testing.T) {
	d := newReadinessFixture(t)
	control := &receiptAdapter{}
	d.adapter = control
	desktop := &fixtureDesktopController{turnID: "desktop-turn"}
	d.desktopController = desktop
	cmd := desktopCommand()
	d.cfg.DesktopSend = false
	if result := d.ExecuteCommand(context.Background(), cmd); result.Status != protocol.StatusFailed || desktop.prepares.Load() != 0 || desktop.sends.Load() != 0 || control.sends.Load() != 0 {
		t.Fatalf("read-only socket granted mutation: %+v", result)
	}
	d.cfg.DesktopSend = true
	cmd.CommandID = "explicitly-enabled"
	res := d.ExecuteCommand(context.Background(), cmd)
	if res.Status != protocol.StatusAccepted {
		t.Fatalf("explicit flag failed to enable fixture: %+v", res)
	}
	d.cfg.DesktopSend = false
	inspection := protocol.InspectTurnMessage{Type: "inspect_turn", CommandID: cmd.CommandID, NodeID: cmd.NodeID, SessionID: cmd.SessionID, TurnID: res.TurnID}
	if result := d.InspectTurn(context.Background(), inspection); result.Status != protocol.StatusCompleted || desktop.sends.Load() != 1 {
		t.Fatalf("flag revocation disabled read-only reconciliation or resent: %+v", result)
	}
}
