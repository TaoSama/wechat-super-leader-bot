package client

import (
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestCatalogRecoveryRepairsExplicitlyUnloadedUnknownNativeRow(t *testing.T) {
	cfg := persistenceConfig(t.TempDir())
	d, err := OpenDaemon(cfg, &catalogRecoveryFixture{resumeFixtureAdapter: resumeFixtureAdapter{endpoint: cfg.SocketPath}})
	if err != nil {
		t.Fatal(err)
	}
	defer closeDaemon(t, d)
	now := time.Now()
	valid := resumeFixtureSession(now)
	unknown := valid
	unknown.Status, unknown.Capabilities = "unknown", []protocol.ActionType{protocol.ActionRead}
	d.sessionSnapshot = []protocol.Session{unknown}
	d.catalogSnapshot = []protocol.Session{{ID: valid.ID, Title: "stored title"}}
	if got := d.catalogRecoveryTargets(now, map[string]time.Time{}, map[string]bool{}); !slices.Equal(got, []string{valid.ID}) {
		t.Fatalf("unloaded unknown native target not inspected: %v", got)
	}
	d.completeCatalogRecovery(catalogRecoveryResult{id: valid.ID, session: valid}, make(chan struct{}, 1))
	got := d.cachedSessions()[0]
	if got.Status != "notLoaded" || got.Loaded == nil || *got.Loaded || !slices.Contains(got.Capabilities, protocol.CapabilityResumeSend) || got.ObservedAt != valid.ObservedAt {
		t.Fatalf("exact read did not recover original unloaded identity: %+v", got)
	}
	managed, ok := d.managedSessionLocked(valid.ID)
	if !ok || managed.Status != "notLoaded" || !d.canResumeSendLocked(valid.ID, now) {
		t.Fatalf("dispatch did not use the same verified target: %+v", managed)
	}
	if d.sessionSnapshot[0].Status != "unknown" {
		t.Fatal("verification rewrote the native observation")
	}
	// An expired verification cannot keep the native unknown row sendable.
	stale := resumeFixtureSession(now.Add(-protocol.MaxSendAvailabilityAge - time.Second))
	d.managedCatalog[valid.ID] = stale
	if got := d.cachedSessions()[0]; got.Status != "unknown" || slices.Contains(got.Capabilities, protocol.CapabilityResumeSend) {
		t.Fatalf("expired verification retained authority: %+v", got)
	}
}

func TestCatalogRecoveryCannotOverrideNativeWriterOrOwner(t *testing.T) {
	now := time.Now()
	valid := resumeFixtureSession(now)
	loaded := true
	for _, tc := range []struct {
		name string
		edit func(*protocol.Session)
	}{
		{"loaded-unknown", func(s *protocol.Session) { s.Status, s.Loaded = "unknown", &loaded }},
		{"unknown-membership", func(s *protocol.Session) { s.Status, s.Loaded = "unknown", nil }},
		{"active", func(s *protocol.Session) { s.Status = "active" }},
		{"approval", func(s *protocol.Session) { s.Status = "waitingForApproval" }},
		{"known-unloaded", func(s *protocol.Session) { s.Status = "notLoaded" }},
		{"other-provider", func(s *protocol.Session) { s.Provider, s.Status = "other", "unknown" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := NewDaemon(persistenceConfig(t.TempDir()), &resumeFixtureAdapter{})
			native := valid
			tc.edit(&native)
			d.sessionSnapshot, d.catalogSnapshot = []protocol.Session{native}, []protocol.Session{{ID: valid.ID}}
			d.managedCatalog[valid.ID] = valid
			if got := d.catalogRecoveryTargets(now, map[string]time.Time{}, map[string]bool{}); len(got) != 0 {
				t.Fatalf("native authority entered recovery: %v", got)
			}
			d.completeCatalogRecovery(catalogRecoveryResult{id: valid.ID, session: valid}, make(chan struct{}, 1))
			if _, ok := d.managedCatalog[valid.ID]; ok {
				t.Fatal("in-flight result overrode changed native authority")
			}
			if got := d.cachedSessions()[0]; got.Status != native.Status || got.Loaded != nil && native.Loaded == nil {
				t.Fatalf("native state changed: %+v", got)
			}
		})
	}
	d := NewDaemon(persistenceConfig(t.TempDir()), &resumeFixtureAdapter{})
	unknown := valid
	unknown.Status = "unknown"
	d.sessionSnapshot, d.catalogSnapshot = []protocol.Session{unknown}, []protocol.Session{{ID: valid.ID}}
	d.desktopSnapshot[valid.ID] = idleReadinessObservation(now, 1)
	if got := d.catalogRecoveryTargets(now, map[string]time.Time{}, map[string]bool{}); len(got) != 0 {
		t.Fatal("fresh desktop owner entered managed recovery")
	}
	d.completeCatalogRecovery(catalogRecoveryResult{id: valid.ID, session: valid}, make(chan struct{}, 1))
	if _, ok := d.managedCatalog[valid.ID]; ok {
		t.Fatal("in-flight read acquired authority after a desktop owner appeared")
	}
}

func TestUnknownNativeRecoveryRequiresFreshExactUnloadedIdleProof(t *testing.T) {
	now := time.Now()
	valid := resumeFixtureSession(now)
	loaded := true
	for _, tc := range []struct {
		name string
		edit func(*catalogRecoveryResult)
	}{
		{"read-failed", func(r *catalogRecoveryResult) { r.err = errors.New("read failed") }},
		{"wrong-id", func(r *catalogRecoveryResult) { r.session.ID = "different" }},
		{"unknown-state", func(r *catalogRecoveryResult) { r.session.Status = "unknown" }},
		{"active-state", func(r *catalogRecoveryResult) { r.session.Status = "active" }},
		{"approval-state", func(r *catalogRecoveryResult) { r.session.Status = "waitingForApproval" }},
		{"loaded-proof", func(r *catalogRecoveryResult) { r.session.Loaded = &loaded }},
		{"loaded-idle-proof", func(r *catalogRecoveryResult) { r.session.Status, r.session.Loaded = "idle", &loaded }},
		{"missing-membership", func(r *catalogRecoveryResult) { r.session.Loaded = nil }},
		{"no-resume-capability", func(r *catalogRecoveryResult) { r.session.Capabilities = []protocol.ActionType{protocol.ActionRead} }},
		{"expired-proof", func(r *catalogRecoveryResult) {
			r.session.ObservedAt = now.Add(-time.Minute).UTC().Format(time.RFC3339Nano)
		}},
		{"future-proof", func(r *catalogRecoveryResult) {
			r.session.ObservedAt = now.Add(time.Minute).UTC().Format(time.RFC3339Nano)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := NewDaemon(persistenceConfig(t.TempDir()), &resumeFixtureAdapter{})
			unknown := valid
			unknown.Status, unknown.Capabilities = "unknown", []protocol.ActionType{protocol.ActionRead}
			d.sessionSnapshot, d.catalogSnapshot = []protocol.Session{unknown}, []protocol.Session{{ID: valid.ID}}
			result := catalogRecoveryResult{id: valid.ID, session: valid}
			tc.edit(&result)
			d.completeCatalogRecovery(result, make(chan struct{}, 1))
			if got := d.cachedSessions()[0]; got.Status != "unknown" || slices.Contains(got.Capabilities, protocol.CapabilityResumeSend) {
				t.Fatalf("invalid exact proof gained send authority: %+v", got)
			}
		})
	}
}
