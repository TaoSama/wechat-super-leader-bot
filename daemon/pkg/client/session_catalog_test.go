package client

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type catalogFixture struct {
	discover func(context.Context) ([]protocol.Session, error)
	read     func(context.Context, string) (string, error)
}

func (f *catalogFixture) DiscoverSessions(ctx context.Context) ([]protocol.Session, error) {
	return f.discover(ctx)
}
func (f *catalogFixture) ReadSession(ctx context.Context, id string) (string, error) {
	return f.read(ctx, id)
}

func TestCatalogMergeNeverGrantsAuthorityOrRefreshesControl(t *testing.T) {
	loaded := true
	control := []protocol.Session{{ID: "same", Status: "idle", Loaded: &loaded, ObservedAt: "old-control", Model: "live",
		Capabilities: []protocol.ActionType{protocol.ActionRead, protocol.ActionSend}}}
	catalog := []protocol.Session{{ID: "same", Model: "stored", Title: "title", ObservedAt: "fresh-file"},
		{ID: "file-only", Status: "idle", Loaded: &loaded, Capabilities: []protocol.ActionType{protocol.ActionSend}},
		{ID: "file-only"}, {ID: "bad id"}}
	got := mergeSessionSources(control, catalog)
	if len(got) != 2 || got[0].Status != "idle" || !*got[0].Loaded || got[0].ObservedAt != "old-control" || got[0].Model != "live" || got[0].Title != "title" {
		t.Fatalf("control observation changed: %+v", got)
	}
	if got[1].Status != "unknown" || *got[1].Loaded || !reflect.DeepEqual(got[1].Capabilities, []protocol.ActionType{protocol.ActionRead}) {
		t.Fatalf("catalog promoted to control: %+v", got[1])
	}
	got[0].Capabilities[0], *got[0].Loaded = protocol.ActionSend, false
	if control[0].Capabilities[0] != protocol.ActionRead || !*control[0].Loaded || control[0].Title != "" {
		t.Fatal("merge mutated source cache")
	}
}

func TestCatalogWorkerAndDesktopProceedWhileControlBlocked(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var active atomic.Int32
	controlStarted := make(chan struct{})
	d := NewDaemon(&config.Config{}, &refreshFixture{discover: func(ctx context.Context) ([]protocol.Session, error) {
		active.Add(1)
		defer active.Add(-1)
		close(controlStarted)
		<-ctx.Done()
		return nil, ctx.Err()
	}})
	d.sessionCatalog = &catalogFixture{discover: func(context.Context) ([]protocol.Session, error) {
		return []protocol.Session{{ID: "file-only", ObservedAt: "file-time"}}, nil
	}}
	observed := make(chan string, 1)
	d.desktopObserver = &desktopFixture{watch: func(ctx context.Context, ids []string, publish func(string, protocol.DesktopObservation)) error {
		if len(ids) != 1 {
			return errors.New("wrong identity list")
		}
		publish(ids[0], protocol.DesktopObservation{Status: "active", Availability: "available", ObservedAt: "desktop-time"})
		observed <- ids[0]
		<-ctx.Done()
		return ctx.Err()
	}}
	updates := make(chan struct{}, 1)
	done := []chan struct{}{make(chan struct{}), make(chan struct{}), make(chan struct{})}
	workers := []func(context.Context, chan<- struct{}){d.refreshSessions, d.refreshSessionCatalog, d.refreshDesktop}
	for i, worker := range workers {
		go func() { defer close(done[i]); worker(ctx, updates) }()
	}
	defer func() {
		cancel()
		for _, ch := range done {
			select {
			case <-ch:
			case <-time.After(time.Second):
				t.Error("worker was not joined")
			}
		}
		if active.Load() != 0 {
			t.Error("control request survived cancellation")
		}
	}()
	select {
	case <-controlStarted:
	case <-time.After(time.Second):
		t.Fatal("control not started")
	}
	select {
	case id := <-observed:
		if id != "file-only" {
			t.Fatal("wrong desktop session")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("control blocked independent catalog observation")
	}
	got := d.cachedSessions()
	if got[0].Status != "unknown" || *got[0].Loaded || got[0].DesktopObservation.Status != "active" || got[0].ObservedAt != "file-time" {
		t.Fatalf("invalid authority merge: %+v", got)
	}
	got[0].DesktopObservation.Status = "mutated"
	if d.cachedSessions()[0].DesktopObservation.Status != "active" {
		t.Fatal("desktop cache aliases public snapshot")
	}
}

func TestCatalogReadMetadataIsLabeledAndErrorsAreSanitized(t *testing.T) {
	d := NewDaemon(&config.Config{}, &refreshFixture{})
	d.sessionCatalog = &catalogFixture{read: func(_ context.Context, id string) (string, error) {
		if id != "known" {
			return "", errors.New("PRIVATE_FILE_CONTENTS")
		}
		return "持久化文件元数据，非 live，历史未读取", nil
	}}
	got, err := d.readSession(context.Background(), "known")
	if err != nil || !strings.Contains(got, "历史未读取") {
		t.Fatalf("wrong read path: %q %v", got, err)
	}
	if _, err := d.readSession(context.Background(), "unknown"); err == nil || strings.Contains(err.Error(), "PRIVATE") {
		t.Fatalf("file error lost or leaked: %v", err)
	}
	d.sessionSnapshot = []protocol.Session{{ID: "known"}}
	if got, err := d.readSession(context.Background(), "known"); err != nil || got != "fixture output" {
		t.Fatalf("control read changed: %q %v", got, err)
	}
}

func TestProbeCatalogSurvivesMissingControlWithoutGrantingSend(t *testing.T) {
	d := NewDaemon(&config.Config{}, &refreshFixture{discover: func(context.Context) ([]protocol.Session, error) {
		return nil, errors.New("PRIVATE_SOCKET_PATH")
	}})
	d.sessionCatalog = &catalogFixture{discover: func(context.Context) ([]protocol.Session, error) {
		return []protocol.Session{{ID: "file-only"}}, nil
	}}
	got, err := d.Probe(context.Background())
	if err != nil || got.Sources.Control || !got.Sources.Catalog || len(got.Warnings) != 1 || len(got.Sessions) != 1 || *got.Sessions[0].Loaded {
		t.Fatalf("invalid degraded probe: %+v %v", got, err)
	}
	d.sessionCatalog = &catalogFixture{discover: func(context.Context) ([]protocol.Session, error) {
		return nil, errors.New("PRIVATE_FILE_PATH")
	}}
	got, err = d.Probe(context.Background())
	if err == nil || len(got.Sessions) != 0 || got.Sources.Catalog || strings.Contains(err.Error(), "PRIVATE") {
		t.Fatalf("all failed sources look successful: %+v %v", got, err)
	}
}

func TestProbeCancellationJoinsControl(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var active atomic.Int32
	started := make(chan struct{})
	d := NewDaemon(&config.Config{}, &refreshFixture{discover: func(ctx context.Context) ([]protocol.Session, error) {
		active.Add(1)
		defer active.Add(-1)
		close(started)
		<-ctx.Done()
		return nil, ctx.Err()
	}})
	done := make(chan error, 1)
	go func() { _, err := d.Probe(ctx); done <- err }()
	<-started
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) || active.Load() != 0 {
			t.Fatalf("probe did not join request: %v, active=%d", err, active.Load())
		}
	case <-time.After(time.Second):
		t.Fatal("probe leaked control request")
	}
}
