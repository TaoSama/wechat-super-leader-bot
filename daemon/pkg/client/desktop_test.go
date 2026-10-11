package client

import (
	"context"
	"errors"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type desktopFixture struct {
	watch func(context.Context, []string, func(string, protocol.DesktopObservation)) error
}

func (f *desktopFixture) Watch(ctx context.Context, ids []string, publish func(string, protocol.DesktopObservation)) error {
	return f.watch(ctx, ids, publish)
}

func TestDesktopCacheCannotGrantSendOrRefreshControlTimestamp(t *testing.T) {
	loaded := false
	d := NewDaemon(&config.Config{}, &refreshFixture{})
	d.sessionSnapshot = []protocol.Session{{ID: "one", Status: "notLoaded", Loaded: &loaded, Capabilities: []protocol.ActionType{protocol.ActionRead}, ObservedAt: "control-old"}}
	updates := make(chan struct{}, 1)
	for _, status := range []string{"active", "idle"} {
		d.publishDesktop("one", protocol.DesktopObservation{Status: status, ObservedAt: "desktop-new", Availability: "available", Source: "codex-desktop"}, updates)
		session := d.cachedSessions()[0]
		if session.Status != "notLoaded" || *session.Loaded || session.ObservedAt != "control-old" || !reflect.DeepEqual(session.Capabilities, []protocol.ActionType{protocol.ActionRead}) {
			t.Fatalf("control authority changed: %+v", session)
		}
		if session.DesktopObservation.Status != status {
			t.Fatal("desktop state not attached")
		}
		session.DesktopObservation.Status = "mutated"
		if d.cachedSessions()[0].DesktopObservation.Status != status {
			t.Fatal("desktop cache aliases public snapshot")
		}
	}
	d.publishDesktop("unknown", protocol.DesktopObservation{Status: "active"}, updates)
	if len(d.desktopSnapshot) != 1 {
		t.Fatal("unscoped desktop result admitted")
	}
	d.publishDesktop("one", protocol.DesktopObservation{Status: "unknown", Availability: "unavailable"}, updates)
	observation := d.cachedSessions()[0].DesktopObservation
	if observation.Status != "idle" || observation.ObservedAt != "desktop-new" || observation.Availability != "unavailable" {
		t.Fatalf("failure fabricated fresh state: %+v", observation)
	}
	d.sessionSnapshot = nil
	d.invalidateDesktop(updates)
	if len(d.desktopSnapshot) != 0 {
		t.Fatal("removed session retained")
	}
}

func TestDesktopComparisonIgnoresOnlyObservationTime(t *testing.T) {
	base := []protocol.Session{{ID: "one", DesktopObservation: &protocol.DesktopObservation{Status: "active", ObservedAt: "before", Availability: "available", Source: "codex-desktop"}}}
	copy := cloneSessions(base)
	copy[0].DesktopObservation.ObservedAt = "after"
	if sessionsChanged(base, copy) || base[0].DesktopObservation.ObservedAt != "before" {
		t.Fatal("time-only change mutated or invalidated cache")
	}
	copy[0].DesktopObservation.Status = "idle"
	if !sessionsChanged(base, copy) {
		t.Fatal("execution state change omitted")
	}
	copy[0].DesktopObservation.Status = "active"
	copy[0].DesktopObservation.Availability = "unavailable"
	if !sessionsChanged(base, copy) {
		t.Fatal("availability change omitted")
	}
}

func TestBlockedDesktopDoesNotBlockControlDiscoveryAndCancels(t *testing.T) {
	var discoveries, watchCalls, active atomic.Int32
	controlCalls := make(chan struct{}, 8)
	adapter := &refreshFixture{discover: func(context.Context) ([]protocol.Session, error) {
		discoveries.Add(1)
		controlCalls <- struct{}{}
		return []protocol.Session{{ID: "one", Status: "notLoaded", ObservedAt: time.Now().UTC().Format(time.RFC3339Nano)}}, nil
	}}
	d := NewDaemon(&config.Config{}, adapter)
	d.sessionSnapshot = []protocol.Session{{ID: "one", Status: "notLoaded"}}
	started := make(chan struct{}, 1)
	d.desktopObserver = &desktopFixture{watch: func(ctx context.Context, ids []string, publish func(string, protocol.DesktopObservation)) error {
		watchCalls.Add(1)
		active.Add(1)
		defer active.Add(-1)
		publish(ids[0], protocol.DesktopObservation{Status: "active", Availability: "available", ObservedAt: "desktop-original", Source: "codex-desktop"})
		started <- struct{}{}
		<-ctx.Done()
		return ctx.Err()
	}}
	ctx, cancel := context.WithCancel(context.Background())
	updates, controlDone, desktopDone := make(chan struct{}, 1), make(chan struct{}), make(chan struct{})
	go func() { defer close(controlDone); d.refreshSessions(ctx, updates) }()
	go func() { defer close(desktopDone); d.refreshDesktop(ctx, updates) }()
	defer func() {
		cancel()
		for _, done := range []chan struct{}{controlDone, desktopDone} {
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Error("worker not joined")
			}
		}
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("desktop observer not started")
	}
	for range 3 {
		select {
		case <-controlCalls:
		case <-time.After(3 * time.Second):
			t.Fatal("desktop blocked control discovery")
		}
	}
	if discoveries.Load() < 3 || watchCalls.Load() != 1 || active.Load() != 1 {
		t.Fatalf("unexpected concurrency: discover=%d watch=%d active=%d", discoveries.Load(), watchCalls.Load(), active.Load())
	}
	cancel()
	select {
	case <-desktopDone:
	case <-time.After(time.Second):
		t.Fatal("desktop cancellation did not join")
	}
	if active.Load() != 0 || d.cachedSessions()[0].DesktopObservation.Availability != "unavailable" {
		t.Fatal("canceled observer retained live state")
	}
}

func TestDesktopTargetChangeJoinsPreviousWatch(t *testing.T) {
	d := NewDaemon(&config.Config{}, &refreshFixture{})
	d.sessionSnapshot = []protocol.Session{{ID: "one"}}
	started := make(chan string, 2)
	var active, maximum atomic.Int32
	d.desktopObserver = &desktopFixture{watch: func(ctx context.Context, ids []string, publish func(string, protocol.DesktopObservation)) error {
		n := active.Add(1)
		defer active.Add(-1)
		if n > maximum.Load() {
			maximum.Store(n)
		}
		started <- ids[0]
		<-ctx.Done()
		publish(ids[0], protocol.DesktopObservation{Status: "active", Availability: "available"})
		return errors.New("fixture canceled")
	}}
	ctx, cancel := context.WithCancel(context.Background())
	done, updates := make(chan struct{}), make(chan struct{}, 1)
	go func() { defer close(done); d.refreshDesktop(ctx, updates) }()
	defer func() {
		cancel()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("watch not joined")
		}
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("first watcher missing")
	}
	d.snapshotMu.Lock()
	d.sessionSnapshot = []protocol.Session{{ID: "two"}}
	d.snapshotMu.Unlock()
	select {
	case id := <-started:
		if id != "two" {
			t.Fatal("new targets not used")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("target change was not observed")
	}
	if maximum.Load() != 1 {
		t.Fatal("desktop requests overlap")
	}
	if _, ok := d.desktopSnapshot["one"]; ok {
		t.Fatal("late removed result was retained")
	}
}

func TestDesktopNormalWindowRenewsWithoutFailureBackoff(t *testing.T) {
	d := NewDaemon(&config.Config{}, &refreshFixture{})
	d.sessionSnapshot = []protocol.Session{{ID: "one"}}
	var calls atomic.Int32
	renewed := make(chan struct{})
	d.desktopObserver = &desktopFixture{watch: func(ctx context.Context, _ []string, _ func(string, protocol.DesktopObservation)) error {
		if calls.Add(1) == 1 {
			return nil // A completed subscription window, not a connection failure.
		}
		close(renewed)
		<-ctx.Done()
		return ctx.Err()
	}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); d.refreshDesktop(ctx, make(chan struct{}, 1)) }()
	defer func() {
		cancel()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("renewed watch did not join")
		}
	}()
	select {
	case <-renewed:
	case <-time.After(time.Second):
		t.Fatal("normal window used the two-second failure backoff")
	}
}

func TestDesktopUnavailableOwnershipPreservesOnlySameOwnerProjection(t *testing.T) {
	placeholder := protocol.DesktopObservation{Status: "unknown", Availability: "unavailable", Source: "codex-desktop"}
	proof := placeholder
	proof.OwnerID = "owner"
	previous := protocol.DesktopObservation{Status: "idle", Availability: "available", Source: "codex-desktop", OwnerID: "owner", Revision: 7,
		ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), Model: "old-model", ModelProvider: "old-provider", ReasoningEffort: "high"}
	stale := previous
	stale.Availability = "unavailable"
	changedOwner := proof
	changedOwner.OwnerID = "new-owner"
	invalidOwner := proof
	invalidOwner.OwnerID = "owner\ufffd"
	for _, tc := range []struct {
		name                   string
		before, incoming, want protocol.DesktopObservation
	}{
		{"cold placeholder", placeholder, proof, proof},
		{"same owner", previous, proof, stale},
		{"same unavailable owner", stale, proof, stale},
		{"changed owner clears metadata", previous, changedOwner, changedOwner},
		{"ownerless disconnect", previous, placeholder, stale},
		{"invalid owner cannot replace proof", previous, invalidOwner, stale},
		{"invalid owner cannot establish proof", placeholder, invalidOwner, placeholder},
	} {
		t.Run(tc.name, func(t *testing.T) {
			loaded := false
			native := protocol.Session{ID: "one", Status: "notLoaded", Loaded: &loaded, Capabilities: []protocol.ActionType{protocol.ActionRead},
				ObservedAt: "control-old", Model: "native-model", ModelProvider: "native-provider", ReasoningEffort: "native-effort"}
			d := NewDaemon(&config.Config{DesktopSend: true}, &refreshFixture{})
			d.sessionSnapshot = []protocol.Session{native, {ID: "native-cli"}}
			d.desktopHistory = &routedDesktopFixture{}
			updates := make(chan struct{}, 1)
			d.publishDesktop("one", tc.before, updates)
			d.publishDesktop("one", tc.incoming, updates)
			if got := d.desktopSnapshot["one"]; got != tc.want {
				t.Fatalf("unavailable merge changed ownership/state: got=%+v want=%+v", got, tc.want)
			}
			var session protocol.Session
			for _, candidate := range d.cachedSessions() {
				if candidate.ID == native.ID {
					session = candidate
				}
			}
			observation, availability := session.DesktopObservation, session.SendAvailability
			session.DesktopObservation, session.SendAvailability = nil, nil
			if !reflect.DeepEqual(session, native) || observation == nil || observation.Availability != "unavailable" {
				t.Fatalf("owner proof changed native authority: %+v", session)
			}
			wantSource := protocol.HistorySourceControl
			if tc.want.OwnerID != "" {
				wantSource = protocol.HistorySourceDesktop
				if availability == nil || availability.State != protocol.SendUnavailable || availability.ObservedAt != uncheckedReadinessTimestamp || availability.ValidUntil != uncheckedReadinessTimestamp {
					t.Fatalf("ownership granted fresh send readiness: %+v", availability)
				}
			} else if availability != nil {
				t.Fatalf("unproven ownership changed native send routing: %+v", availability)
			}
			if got := d.preferredHistorySource("one"); got != wantSource {
				t.Fatalf("history ownership route=%q want=%q", got, wantSource)
			}
			d.publishDesktop("native-cli", placeholder, updates)
			if d.preferredHistorySource("native-cli") != protocol.HistorySourceControl {
				t.Fatal("unknown CLI target was routed to desktop")
			}
			if _, exists := d.sendReadiness["native-cli"]; exists {
				t.Fatal("unknown CLI target gained desktop send denial")
			}
			if jobs := d.readinessSweep(time.Now(), map[string]bool{}, readinessConcurrency, updates); len(jobs) != 0 {
				t.Fatalf("ownership alone queued send preflight: %+v", jobs)
			}
			d.invalidateDesktop(updates)
			d.publishDesktop("one", placeholder, updates)
			if d.preferredHistorySource("one") != wantSource || d.desktopSnapshot["one"] != tc.want {
				t.Fatal("disconnection lost ownership or silently changed history source")
			}
		})
	}
}
