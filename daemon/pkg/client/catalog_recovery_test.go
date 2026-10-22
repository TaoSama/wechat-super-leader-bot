package client

import (
	"context"
	"errors"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type catalogRecoveryFixture struct {
	resumeFixtureAdapter
	inspect func(context.Context, string) (protocol.Session, error)
}

func (a *catalogRecoveryFixture) InspectSession(ctx context.Context, id string) (protocol.Session, error) {
	return a.inspect(ctx, id)
}

func TestCatalogRecoveryRequiresExactLiveProofAndPreservesNativeAuthority(t *testing.T) {
	cfg := persistenceConfig(t.TempDir())
	a := &catalogRecoveryFixture{resumeFixtureAdapter: resumeFixtureAdapter{endpoint: cfg.SocketPath, turnID: "resume-turn"}}
	d, err := OpenDaemon(cfg, a)
	if err != nil {
		t.Fatal(err)
	}
	defer closeDaemon(t, d)
	d.catalogSnapshot = []protocol.Session{{ID: "fixture-session", Title: "stored title"}}
	assertResume := func(want bool) {
		t.Helper()
		got := d.cachedSessions()[0]
		if slices.Contains(got.Capabilities, protocol.CapabilityResumeSend) != want {
			t.Fatalf("resume eligibility=%t, want=%t session=%+v", !want, want, got)
		}
	}
	assertResume(false)
	updates := make(chan struct{}, 1)
	now := time.Now()
	valid := resumeFixtureSession(now)
	for _, result := range []catalogRecoveryResult{
		{id: valid.ID, session: valid, err: errors.New("read failed")},
		{id: valid.ID, session: protocol.Session{ID: "different"}},
		{id: valid.ID, session: protocol.Session{ID: valid.ID, Status: "notLoaded"}},
	} {
		d.completeCatalogRecovery(result, updates)
		assertResume(false)
	}
	d.completeCatalogRecovery(catalogRecoveryResult{id: valid.ID, session: valid}, updates)
	assertResume(true)
	if got := d.cachedSessions()[0]; got.ObservedAt != valid.ObservedAt || got.Title != "stored title" || got.Status != "notLoaded" {
		t.Fatalf("live proof or catalog metadata lost: %+v", got)
	}
	active := valid
	active.Status = "active"
	active.Capabilities = []protocol.ActionType{protocol.ActionRead}
	d.sessionSnapshot = []protocol.Session{active}
	assertResume(false)
	if got := d.cachedSessions()[0]; got.Status != "active" {
		t.Fatal("catalog verification overrode native discovery")
	}
	d.sessionSnapshot = nil
	d.completeCatalogRecovery(catalogRecoveryResult{id: valid.ID, session: valid, err: errors.New("connection lost")}, updates)
	assertResume(false)
	d.completeCatalogRecovery(catalogRecoveryResult{id: valid.ID, session: valid}, updates)
	cmd := resumeCommand()
	if got := d.ExecuteCommand(context.Background(), cmd); got.Status != protocol.StatusAccepted || a.resumes.Load() != 1 {
		t.Fatalf("explicit catalog recovery did not use original managed route: %+v", got)
	}
}

func TestCatalogRecoveryWorkerIsBoundedReadonlyAndCancels(t *testing.T) {
	cfg := persistenceConfig(t.TempDir())
	var calls, active, maximum atomic.Int32
	started := make(chan struct{}, catalogRecoveryConcurrency)
	a := &catalogRecoveryFixture{resumeFixtureAdapter: resumeFixtureAdapter{endpoint: cfg.SocketPath}, inspect: func(ctx context.Context, id string) (protocol.Session, error) {
		calls.Add(1)
		n := active.Add(1)
		defer active.Add(-1)
		for old := maximum.Load(); n > old && !maximum.CompareAndSwap(old, n); old = maximum.Load() {
		}
		started <- struct{}{}
		<-ctx.Done()
		return protocol.Session{}, ctx.Err()
	}}
	d, err := OpenDaemon(cfg, a)
	if err != nil {
		t.Fatal(err)
	}
	defer closeDaemon(t, d)
	d.sessionCatalog = &catalogFixture{}
	d.catalogSnapshot = []protocol.Session{{ID: "a"}, {ID: "b"}, {ID: "c"}, {ID: "native"}, {ID: "desktop"}}
	d.sessionSnapshot = []protocol.Session{{ID: "native"}}
	d.desktopSnapshot["desktop"] = idleReadinessObservation(time.Now(), 1)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); d.refreshCatalogRecovery(ctx, make(chan struct{}, 1)) }()
	for range catalogRecoveryConcurrency {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("catalog verifier did not start")
		}
	}
	if maximum.Load() != catalogRecoveryConcurrency || calls.Load() != catalogRecoveryConcurrency || a.resumes.Load() != 0 || a.sends.Load() != 0 {
		t.Fatal("catalog verification exceeded bound or mutated a session")
	}
	if len(d.cachedSessions()) != 5 {
		t.Fatal("blocked verification stalled snapshot access")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("catalog verification did not join canceled workers")
	}
	if active.Load() != 0 {
		t.Fatal("catalog verification survived cancellation")
	}
}

func TestCatalogRecoveryUsesCooldownAndDropsRemovedProof(t *testing.T) {
	d := NewDaemon(persistenceConfig(t.TempDir()), &resumeFixtureAdapter{})
	d.catalogSnapshot = []protocol.Session{{ID: "b"}, {ID: "a"}}
	now := time.Now()
	next := map[string]time.Time{"a": now.Add(time.Second)}
	if got := d.catalogRecoveryTargets(now, next, map[string]bool{}); !slices.Equal(got, []string{"b"}) {
		t.Fatalf("cooldown ignored: %v", got)
	}
	d.managedCatalog["removed"] = resumeFixtureSession(now)
	next["removed"] = now
	d.catalogRecoveryTargets(now, next, map[string]bool{"b": true})
	if _, ok := d.managedCatalog["removed"]; ok {
		t.Fatal("removed identity retained live proof")
	}
	if _, ok := next["removed"]; ok {
		t.Fatal("removed identity retained scheduling state")
	}
}
