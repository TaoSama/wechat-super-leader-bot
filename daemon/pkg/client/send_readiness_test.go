package client

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	codexdesktop "github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/desktop"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type readinessFixtureController struct {
	fixtureDesktopController
	check func(context.Context, string) error
}

func (f *readinessFixtureController) CheckSendReadiness(ctx context.Context, id string) error {
	return f.check(ctx, id)
}

func newReadinessFixture(t *testing.T) *Daemon {
	t.Helper()
	cfg := persistenceConfig(t.TempDir())
	cfg.DesktopSend, cfg.DesktopSocketPath = true, fixtureDesktopSocket
	d, err := OpenDaemon(cfg, &receiptAdapter{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { closeDaemon(t, d) })
	loaded := false
	d.sessionSnapshot = []protocol.Session{{ID: "fixture-session", Status: "notLoaded", Loaded: &loaded,
		Capabilities: []protocol.ActionType{protocol.ActionRead}, ObservedAt: "native-original"}}
	return d
}

func idleReadinessObservation(now time.Time, revision uint64) protocol.DesktopObservation {
	return protocol.DesktopObservation{Status: "idle", Availability: "available", Source: "codex-desktop",
		ObservedAt: now.UTC().Format(time.RFC3339Nano), OwnerID: "fixture-owner", Revision: revision}
}

func drainReadinessUpdates(updates <-chan struct{}) {
	for {
		select {
		case <-updates:
		default:
			return
		}
	}
}

func TestNativeSendRemainsUntilDesktopOwnerIsProven(t *testing.T) {
	d := newReadinessFixture(t)
	now := time.Now()
	loaded := true
	native := protocol.Session{ID: "native-only", Status: "idle", Loaded: &loaded,
		Capabilities: []protocol.ActionType{protocol.ActionRead, protocol.ActionSend},
		ObservedAt:   now.UTC().Format(time.RFC3339Nano)}
	d.sessionSnapshot = []protocol.Session{native}
	updates := make(chan struct{}, 1)
	assertNativeUnchanged := func() protocol.Session {
		t.Helper()
		got := d.cachedSessions()[0]
		control := got
		control.DesktopObservation, control.SendAvailability = nil, nil
		if !reflect.DeepEqual(control, native) {
			t.Fatalf("desktop observation changed native send facts: %+v", got)
		}
		return got
	}
	for _, observation := range []protocol.DesktopObservation{
		{Status: "unknown", Availability: "unavailable", Source: "codex-desktop"},
		{Status: "unknown", Availability: "unavailable", Source: "codex-desktop"},
		{Status: "idle", Availability: "available", Source: "codex-desktop", ObservedAt: native.ObservedAt},
	} {
		d.publishDesktop(native.ID, observation, updates)
		got := assertNativeUnchanged()
		if got.SendAvailability != nil {
			t.Fatalf("unproven desktop owner disabled native send: %+v", got.SendAvailability)
		}
		if jobs := d.readinessSweep(now, map[string]bool{}, readinessConcurrency, updates); len(jobs) != 0 {
			t.Fatalf("unproven owner scheduled desktop probes: %+v", jobs)
		}
		wire, err := json.Marshal(got)
		if err != nil || strings.Contains(string(wire), "sendAvailability") {
			t.Fatalf("native-only wire gained desktop authority: %s %v", wire, err)
		}
		d.invalidateDesktop(updates)
		if got := assertNativeUnchanged(); got.SendAvailability != nil {
			t.Fatalf("unproven owner invalidation disabled native send: %+v", got.SendAvailability)
		}
	}
	d.publishDesktop(native.ID, idleReadinessObservation(now, 1), updates)
	checking := assertNativeUnchanged().SendAvailability
	if checking == nil || checking.State != protocol.SendBlocked || checking.Reason != protocol.SendReasonChecking {
		t.Fatalf("proven owner did not enter checking: %+v", checking)
	}
	jobs := d.readinessSweep(now, map[string]bool{}, readinessConcurrency, updates)
	if len(jobs) != 1 || jobs[0].ID != native.ID {
		t.Fatalf("proven idle owner not scheduled: %+v", jobs)
	}
	d.completeReadiness(readinessResult{readinessJob: jobs[0]}, now, updates)
	ready := assertNativeUnchanged().SendAvailability
	if ready == nil || ready.State != protocol.SendReady {
		t.Fatalf("proven owner did not become ready: %+v", ready)
	}
	for range 2 {
		d.publishDesktop(native.ID, protocol.DesktopObservation{Status: "unknown", Availability: "unavailable", Source: "codex-desktop"}, updates)
		d.invalidateDesktop(updates)
		denial := assertNativeUnchanged().SendAvailability
		if denial == nil || denial.State != protocol.SendUnavailable || denial.ObservedAt != ready.ObservedAt || denial.ValidUntil != ready.ValidUntil {
			t.Fatalf("disconnect lost desktop denial or original check time: %+v", denial)
		}
	}
}

func TestDesktopReadinessIsIndependentAndInvalidationPreservesCheckTime(t *testing.T) {
	d := newReadinessFixture(t)
	updates := make(chan struct{}, 1)
	now := time.Now()
	observation := idleReadinessObservation(now, 1)
	d.publishDesktop("fixture-session", observation, updates)
	before := d.cachedSessions()[0]
	if before.SendAvailability == nil || before.SendAvailability.State == protocol.SendReady {
		t.Fatal("observer idle granted readiness")
	}
	if before.SendAvailability.ObservedAt != uncheckedReadinessTimestamp || before.SendAvailability.ValidUntil != uncheckedReadinessTimestamp {
		t.Fatal("unchecked qualification pretended to be a new preflight")
	}
	job := readinessJob{ID: before.ID, Generation: d.desktopGeneration[before.ID]}
	d.completeReadiness(readinessResult{readinessJob: job}, now, updates)
	ready := d.cachedSessions()[0]
	if ready.SendAvailability == nil || ready.SendAvailability.State != protocol.SendReady || ready.Status != before.Status ||
		*ready.Loaded || ready.ObservedAt != "native-original" || !reflect.DeepEqual(ready.Capabilities, []protocol.ActionType{protocol.ActionRead}) {
		t.Fatalf("desktop readiness rewrote native facts: %+v", ready)
	}
	stamp, until := ready.SendAvailability.ObservedAt, ready.SendAvailability.ValidUntil
	for _, change := range []struct {
		name  string
		apply func(*protocol.DesktopObservation)
		state protocol.SendAvailabilityState
	}{
		{"revision", func(o *protocol.DesktopObservation) { o.Revision++ }, protocol.SendBlocked},
		{"owner", func(o *protocol.DesktopObservation) { o.OwnerID = "another-owner" }, protocol.SendBlocked},
		{"busy", func(o *protocol.DesktopObservation) { o.Status = "active" }, protocol.SendBlocked},
		{"unknown", func(o *protocol.DesktopObservation) { o.Status = "unknown" }, protocol.SendUnavailable},
		{"disconnect", func(o *protocol.DesktopObservation) { o.Availability = "unavailable" }, protocol.SendUnavailable},
	} {
		t.Run(change.name, func(t *testing.T) {
			d.publishDesktop(before.ID, observation, updates)
			d.completeReadiness(readinessResult{readinessJob: readinessJob{ID: before.ID, Generation: d.desktopGeneration[before.ID]}}, now, updates)
			drainReadinessUpdates(updates)
			changed := observation
			change.apply(&changed)
			d.publishDesktop(before.ID, changed, updates)
			got := d.cachedSessions()[0].SendAvailability
			if got == nil || got.State != change.state || got.ObservedAt != stamp || got.ValidUntil != until {
				t.Fatalf("invalidation forged a new check: %+v", got)
			}
			select {
			case <-updates:
			default:
				t.Fatal("readiness revocation did not notify heartbeat")
			}
		})
	}
	if desktopChanged(observation, idleReadinessObservation(now.Add(time.Second), 2)) {
		t.Fatal("internal revision alone triggered full telemetry heartbeat")
	}
}

func TestReadinessGenerationExpiryAndThirtySecondRecheck(t *testing.T) {
	d := newReadinessFixture(t)
	updates := make(chan struct{}, 1)
	now := time.Now()
	id := "fixture-session"
	d.publishDesktop(id, idleReadinessObservation(now, 1), updates)
	jobs := d.readinessSweep(now, map[string]bool{}, readinessConcurrency, updates)
	if len(jobs) != 1 {
		t.Fatal("fresh idle target not scheduled")
	}
	d.publishDesktop(id, idleReadinessObservation(now.Add(time.Millisecond), 2), updates)
	before := d.cachedSessions()[0].SendAvailability.ObservedAt
	d.completeReadiness(readinessResult{readinessJob: jobs[0]}, now.Add(time.Second), updates)
	if got := d.cachedSessions()[0].SendAvailability; got.State == protocol.SendReady || got.ObservedAt != before {
		t.Fatalf("old generation granted ready or renewed time: %+v", got)
	}
	checkTime := now.Add(time.Second)
	if jobs := d.readinessSweep(checkTime.Add(readinessRecheck-time.Nanosecond), map[string]bool{}, 2, updates); len(jobs) != 0 {
		t.Fatal("probe repeated before thirty seconds")
	}
	jobs = d.readinessSweep(checkTime.Add(readinessRecheck), map[string]bool{}, 2, updates)
	if len(jobs) != 1 {
		t.Fatal("probe did not resume after thirty seconds")
	}
	d.completeReadiness(readinessResult{readinessJob: jobs[0]}, checkTime, updates)
	ready := d.sendReadiness[id]
	at, err := time.Parse(time.RFC3339Nano, ready.Availability.ObservedAt)
	if err != nil {
		t.Fatal(err)
	}
	until, err := time.Parse(time.RFC3339Nano, ready.Availability.ValidUntil)
	if err != nil || until.Sub(at) != protocol.MaxSendAvailabilityAge {
		t.Fatalf("readiness validity changed: %v %v", until.Sub(at), err)
	}
	d.snapshotMu.RLock()
	expired := d.currentSendAvailabilityLocked(id, ready, until)
	d.snapshotMu.RUnlock()
	if expired.State == protocol.SendReady || expired.ObservedAt != ready.Availability.ObservedAt {
		t.Fatalf("expired qualification still ready or renewed time: %+v", expired)
	}
	for _, offset := range []time.Duration{-protocol.MaxSendAvailabilityAge - time.Millisecond, time.Second} {
		observation := idleReadinessObservation(now.Add(offset), 3)
		if freshDesktopIdle(observation, now) {
			t.Fatal("stale or future observer granted eligibility")
		}
	}
}

func TestReadinessFailureClassificationAndWireIsolation(t *testing.T) {
	d := newReadinessFixture(t)
	now := time.Now()
	updates := make(chan struct{}, 1)
	d.publishDesktop("fixture-session", idleReadinessObservation(now, 7), updates)
	for _, tc := range []struct {
		err    error
		state  protocol.SendAvailabilityState
		reason protocol.SendAvailabilityReason
	}{
		{codexdesktop.ErrDesktopSendBusy, protocol.SendBlocked, protocol.SendReasonBusy},
		{errors.New("unknown settings"), protocol.SendBlocked, protocol.SendReasonPreflightRejected},
		{context.DeadlineExceeded, protocol.SendUnavailable, protocol.SendReasonUnavailable},
	} {
		d.completeReadiness(readinessResult{readinessJob: readinessJob{ID: "fixture-session", Generation: d.desktopGeneration["fixture-session"]}, Err: tc.err}, now, updates)
		got := d.cachedSessions()[0]
		if got.SendAvailability.State != tc.state || got.SendAvailability.Reason != tc.reason {
			t.Fatalf("incorrect failed eligibility: %+v", got.SendAvailability)
		}
		copy := cloneSessions([]protocol.Session{got})
		copy[0].SendAvailability.State = protocol.SendReady
		if got.SendAvailability.State != tc.state || !sessionsChanged([]protocol.Session{got}, copy) {
			t.Fatal("clone aliased qualification or comparison missed change")
		}
		wire, err := json.Marshal(got)
		if err != nil || strings.Contains(string(wire), "fixture-owner") || strings.Contains(string(wire), "revision") || !strings.Contains(string(wire), "sendAvailability") {
			t.Fatalf("internal observer proof leaked or contract lost: %s %v", wire, err)
		}
	}
}

func TestReadinessSchedulingIsFairAndPrunesWithoutGenerationABA(t *testing.T) {
	d := newReadinessFixture(t)
	updates := make(chan struct{}, 1)
	now := time.Now()
	d.sessionSnapshot = []protocol.Session{{ID: "a-checked"}, {ID: "z-unchecked"}, {ID: "unknown"}, {ID: "busy"}, {ID: "stale"}}
	for _, session := range d.sessionSnapshot {
		observation := idleReadinessObservation(now, 1)
		if session.ID == "unknown" {
			observation.Status = "unknown"
		} else if session.ID == "busy" {
			observation.Status = "active"
		} else if session.ID == "stale" {
			observation.ObservedAt = now.Add(-2 * protocol.MaxSendAvailabilityAge).UTC().Format(time.RFC3339Nano)
		}
		d.publishDesktop(session.ID, observation, updates)
	}
	d.completeReadiness(readinessResult{readinessJob: readinessJob{ID: "a-checked", Generation: d.desktopGeneration["a-checked"]}, Err: errors.New("rejected")}, now.Add(-readinessRecheck), updates)
	jobs := d.readinessSweep(now, map[string]bool{}, 1, updates)
	if len(jobs) != 1 || jobs[0].ID != "z-unchecked" {
		t.Fatalf("unchecked target starved behind reprobe or non-idle targeted: %+v", jobs)
	}
	if jobs := d.readinessSweep(now, map[string]bool{"z-unchecked": true, "a-checked": true}, 2, updates); len(jobs) != 0 {
		t.Fatalf("single-flight or idle-only filter failed: %+v", jobs)
	}
	oldGeneration := d.desktopGeneration["z-unchecked"]
	d.sessionSnapshot = []protocol.Session{{ID: "a-checked"}}
	d.readinessSweep(now, map[string]bool{}, 0, updates)
	if _, exists := d.desktopGeneration["z-unchecked"]; exists {
		t.Fatal("removed target retained observer generation map")
	}
	d.sessionSnapshot = append(d.sessionSnapshot, protocol.Session{ID: "z-unchecked"})
	d.publishDesktop("z-unchecked", idleReadinessObservation(now, 1), updates)
	if d.desktopGeneration["z-unchecked"] <= oldGeneration {
		t.Fatal("remove/re-add recycled observer proof generation")
	}
	d.completeReadiness(readinessResult{readinessJob: readinessJob{ID: "z-unchecked", Generation: oldGeneration}}, now, updates)
	if got := d.sendReadiness["z-unchecked"].Availability; got.State == protocol.SendReady || got.ObservedAt != uncheckedReadinessTimestamp {
		t.Fatalf("removed target's late probe qualified re-added target: %+v", got)
	}
}

func TestReadinessComparisonIgnoresInternalProofButDetectsValidityRenewal(t *testing.T) {
	now := time.Now()
	previous := []protocol.Session{{ID: "one", DesktopObservation: func() *protocol.DesktopObservation {
		observation := idleReadinessObservation(now, 1)
		return &observation
	}(), SendAvailability: &protocol.SendAvailability{Route: protocol.RouteDesktopOwner, State: protocol.SendReady,
		ObservedAt: now.UTC().Format(time.RFC3339Nano), ValidUntil: now.Add(protocol.MaxSendAvailabilityAge).UTC().Format(time.RFC3339Nano)}}}
	current := cloneSessions(previous)
	current[0].DesktopObservation.Revision++
	current[0].DesktopObservation.OwnerID = "internal-change"
	if sessionsChanged(previous, current) {
		t.Fatal("internal proof alone triggered public snapshot change")
	}
	current[0].SendAvailability.ValidUntil = now.Add(protocol.MaxSendAvailabilityAge - time.Second).UTC().Format(time.RFC3339Nano)
	if !sessionsChanged(previous, current) {
		t.Fatal("readiness validity change was hidden from heartbeat")
	}
}
