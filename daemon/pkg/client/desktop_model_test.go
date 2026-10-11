package client

import (
	"reflect"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestDesktopModelUpdatesNotifyWithoutChangingNativeOrSendProof(t *testing.T) {
	d := newReadinessFixture(t)
	native := d.sessionSnapshot[0]
	native.Model, native.ModelProvider, native.ReasoningEffort = "native-model", "native-provider", "native-effort"
	d.sessionSnapshot[0] = native
	now := time.Now()
	updates := make(chan struct{}, 1)
	observation := idleReadinessObservation(now, 1)
	observation.Model, observation.ModelProvider, observation.ReasoningEffort = "desktop-model", "desktop-provider", "ultra"
	d.publishDesktop(native.ID, observation, updates)
	d.completeReadiness(readinessResult{readinessJob: readinessJob{ID: native.ID, Generation: d.desktopGeneration[native.ID]}}, now, updates)
	for _, state := range []string{"idle", "active"} {
		observation.Status = state
		d.publishDesktop(native.ID, observation, updates)
		for _, field := range []string{"model", "provider", "effort", "cleared"} {
			before := d.cachedSessions()[0]
			drainReadinessUpdates(updates)
			switch field {
			case "model":
				observation.Model += "-new"
			case "provider":
				observation.ModelProvider += "-new"
			case "effort":
				observation.ReasoningEffort += "-new"
			case "cleared":
				observation.Model, observation.ModelProvider, observation.ReasoningEffort = "", "", ""
			}
			d.publishDesktop(native.ID, observation, updates)
			after := d.cachedSessions()[0]
			control := after
			control.DesktopObservation, control.SendAvailability = nil, nil
			if !reflect.DeepEqual(control, native) || !reflect.DeepEqual(before.SendAvailability, after.SendAvailability) {
				t.Fatalf("model update changed control facts or send proof: before=%+v after=%+v", before, after)
			}
			if !sessionsChanged([]protocol.Session{before}, []protocol.Session{after}) || !desktopChanged(*before.DesktopObservation, *after.DesktopObservation) {
				t.Fatal("model change hidden from update comparison")
			}
			select {
			case <-updates:
			default:
				t.Fatal("model update did not notify heartbeat")
			}
			copy := cloneSessions([]protocol.Session{after})
			copy[0].DesktopObservation.Model = "mutated"
			if d.cachedSessions()[0].DesktopObservation.Model != observation.Model {
				t.Fatal("cloned observation aliases cache")
			}
		}
	}
	// A disconnect retains prior telemetry and time, never refreshing its age.
	observation.Model, observation.ModelProvider, observation.ReasoningEffort = "last-model", "last-provider", "high"
	d.publishDesktop(native.ID, observation, updates)
	before := d.cachedSessions()[0].DesktopObservation
	d.publishDesktop(native.ID, protocol.DesktopObservation{Status: "unknown", Availability: "unavailable", Source: "codex-desktop",
		ObservedAt: now.Add(time.Hour).Format(time.RFC3339Nano), Model: "fabricated"}, updates)
	after := d.cachedSessions()[0].DesktopObservation
	want := *before
	want.Availability = "unavailable"
	if *after != want {
		t.Fatalf("disconnect fabricated metadata or observation time: %+v", after)
	}
}
