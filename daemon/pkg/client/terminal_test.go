package client

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/skills"
)

func terminalFixtureSession(identity string) protocol.Session {
	digest := sha256.Sum256([]byte(identity))
	return protocol.Session{ID: terminalSessionPrefix + base64.RawURLEncoding.EncodeToString(digest[:]),
		Provider: "terminal/fixture", Status: "active", Title: "fixture pane", ObservedAt: "original-time"}
}

type terminalRouteAdapter struct{ reads, sends, inspections, histories atomic.Int32 }

func (a *terminalRouteAdapter) DiscoverSessions(context.Context) ([]protocol.Session, error) {
	return nil, nil
}
func (a *terminalRouteAdapter) ReadSession(context.Context, string) (string, error) {
	a.reads.Add(1)
	return "native output", nil
}
func (a *terminalRouteAdapter) SendPrompt(context.Context, string, string) (string, error) {
	a.sends.Add(1)
	return "turnId=native-turn", nil
}
func (a *terminalRouteAdapter) InspectTurn(context.Context, string, string) (codex.TurnObservation, error) {
	a.inspections.Add(1)
	return codex.TurnObservation{Status: "completed"}, nil
}
func (a *terminalRouteAdapter) ReadHistory(context.Context, string, string, int) (protocol.SessionHistory, error) {
	a.histories.Add(1)
	return protocol.SessionHistory{}, nil
}

func TestTerminalConstructorIsExplicitAndDoesNotConnect(t *testing.T) {
	d := NewDaemon(&config.Config{}, &terminalRouteAdapter{})
	if d.terminalObserver != nil {
		t.Fatal("terminal enabled by default")
	}
	cfg := &config.Config{TerminalSocketPath: "/nonexistent/fixture.sock", TerminalPanes: []string{"w1:p1"}}
	d = NewDaemon(cfg, &terminalRouteAdapter{})
	if d.terminalObserver == nil || len(d.cachedSessions()) != 0 {
		t.Fatal("explicit observer not constructed lazily")
	}
}

func TestTerminalNormalizationAndReservedNamespace(t *testing.T) {
	s := terminalFixtureSession("one")
	loaded := true
	s.Loaded, s.Capabilities = &loaded, []protocol.ActionType{protocol.ActionSend}
	s.DesktopObservation = &protocol.DesktopObservation{OwnerID: "fake-owner"}
	s.SendAvailability = &protocol.SendAvailability{State: protocol.SendReady}
	s.Model, s.ModelProvider, s.ReasoningEffort, s.Preview = "fake-model", "fake-provider", "high", "fake-preview"
	got, err := normalizeTerminalSessions([]protocol.Session{s})
	if err != nil || len(got) != 1 {
		t.Fatalf("normalize: %+v %v", got, err)
	}
	if *got[0].Loaded || !reflect.DeepEqual(got[0].Capabilities, []protocol.ActionType{protocol.ActionRead}) ||
		got[0].DesktopObservation != nil || got[0].SendAvailability != nil || got[0].Model != "" || got[0].Preview != "" || got[0].ModelProvider != "" || got[0].ReasoningEffort != "" {
		t.Fatalf("terminal gained native authority: %+v", got[0])
	}
	if !loaded || s.Capabilities[0] != protocol.ActionSend || s.Model != "fake-model" {
		t.Fatal("normalization mutated input")
	}
	if merged := mergeSessionSources([]protocol.Session{s, {ID: "native"}}, []protocol.Session{s}); len(merged) != 1 || merged[0].ID != "native" {
		t.Fatalf("native sources contributed reserved identity: %+v", merged)
	}
	for _, bad := range []protocol.Session{{ID: "native", Provider: s.Provider}, {ID: "terminal:malformed", Provider: s.Provider},
		{ID: s.ID + "=", Provider: s.Provider}, {ID: s.ID, Provider: "terminal/"}, {ID: s.ID, Provider: "codex"}} {
		if _, err := normalizeTerminalSessions([]protocol.Session{bad}); err == nil {
			t.Fatalf("accepted bad inventory: %+v", bad)
		}
	}
	if _, err := normalizeTerminalSessions([]protocol.Session{s, s}); err == nil {
		t.Fatal("accepted duplicate identity")
	}
	if _, err := normalizeTerminalSessions(make([]protocol.Session, config.MaxTerminalPanes+1)); err == nil {
		t.Fatal("accepted oversized inventory")
	}
}

func TestTerminalFailurePreservesTimestampAndOtherSources(t *testing.T) {
	s := terminalFixtureSession("one")
	d := NewDaemon(&config.Config{}, &terminalRouteAdapter{})
	d.sessionSnapshot = []protocol.Session{{ID: "native", Status: "idle", ObservedAt: "native-time"}}
	d.catalogSnapshot = []protocol.Session{{ID: "stored", ObservedAt: "file-time"}}
	var unavailable bool
	d.terminalObserver = &catalogFixture{discover: func(context.Context) ([]protocol.Session, error) {
		if unavailable {
			return nil, errors.New("PRIVATE_SOCKET")
		}
		return []protocol.Session{s}, nil
	}}
	d.refreshTerminalSnapshot(context.Background(), nil)
	got := d.cachedSessions()
	got[2].Capabilities[0], *got[2].Loaded = protocol.ActionSend, true
	if current := d.cachedSessions()[2]; *current.Loaded || current.Capabilities[0] != protocol.ActionRead {
		t.Fatal("cache aliases caller")
	}
	unavailable = true
	d.refreshTerminalSnapshot(context.Background(), nil)
	got = d.cachedSessions()
	if got[2].Status != "unknown" || got[2].ObservedAt != s.ObservedAt || got[2].Title != s.Title ||
		got[0].Status != "idle" || got[0].ObservedAt != "native-time" || got[1].ObservedAt != "file-time" {
		t.Fatalf("failure refreshed stale observation or another source: %+v", got)
	}
	unavailable = false
	s = terminalFixtureSession("new-identity")
	s.ObservedAt, s.Status = "new-time", "blocked"
	d.refreshTerminalSnapshot(context.Background(), nil)
	got = d.cachedSessions()
	if len(got) != 3 || got[2].ID != s.ID || got[2].Status != "blocked" || got[2].ObservedAt != "new-time" {
		t.Fatalf("identity recovery: %+v", got)
	}
}

func TestTerminalReadNeverFallsBack(t *testing.T) {
	a := &terminalRouteAdapter{}
	d := NewDaemon(&config.Config{NodeID: "demoair"}, a)
	id := terminalFixtureSession("one").ID
	var terminalReads, catalogReads atomic.Int32
	d.sessionSnapshot = []protocol.Session{{ID: id}}
	d.sessionCatalog = &catalogFixture{read: func(context.Context, string) (string, error) {
		catalogReads.Add(1)
		return "catalog output", nil
	}}
	for _, target := range []string{id, "terminal:malformed"} {
		if _, err := d.readSession(context.Background(), target); err == nil {
			t.Fatal("disabled terminal fell back")
		}
	}
	d.terminalObserver = &catalogFixture{read: func(_ context.Context, target string) (string, error) {
		terminalReads.Add(1)
		if target != id {
			return "", errors.New("PRIVATE_SOCKET_PATH")
		}
		return "终端快照（非完整对话）\n裁剪提示：有限屏幕文本", nil
	}}
	cmd := persistenceCommand(time.Now().Add(time.Minute).Format(time.RFC3339Nano))
	cmd.Action, cmd.Prompt, cmd.SessionID = protocol.ActionRead, "", id
	res := d.ExecuteCommand(context.Background(), cmd)
	if res.Status != protocol.StatusCompleted || res.TurnID != "" || !strings.Contains(res.Output, "终端快照") {
		t.Fatalf("read fabricated turn: %+v", res)
	}
	if _, err := d.readSession(context.Background(), "terminal:malformed"); err == nil || strings.Contains(err.Error(), "PRIVATE") {
		t.Fatalf("bad failure: %v", err)
	}
	if terminalReads.Load() != 2 || a.reads.Load() != 0 || catalogReads.Load() != 0 {
		t.Fatal("terminal read reached other source")
	}
	d.terminalObserver = &catalogFixture{read: func(ctx context.Context, _ string) (string, error) { <-ctx.Done(); return "", ctx.Err() }}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, err := d.readSession(ctx, id); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("read cancellation lost: %v", err)
	}
}

func TestTerminalSendAndInspectAreLocallyRejected(t *testing.T) {
	for _, durable := range []bool{false, true} {
		for _, route := range []protocol.SendRoute{"", protocol.RouteControlSocket, protocol.RouteDesktopOwner} {
			cfg := persistenceConfig(t.TempDir())
			cfg.DesktopSend, cfg.DesktopSocketPath = true, fixtureDesktopSocket
			a := &terminalRouteAdapter{}
			d := NewDaemon(cfg, a)
			if durable {
				var err error
				d, err = OpenDaemon(cfg, a)
				if err != nil {
					t.Fatal(err)
				}
			}
			desktop := &fixtureDesktopController{}
			d.desktopController = desktop
			cmd := persistenceCommand(time.Now().Add(time.Minute).Format(time.RFC3339Nano))
			cmd.SessionID, cmd.SendRoute = terminalFixtureSession("one").ID, route
			cmd.Skills = []skills.Ref{{ID: strings.Repeat("b", 64), Digest: strings.Repeat("a", 64)}}
			res := d.ExecuteCommand(context.Background(), cmd)
			if res.Status != protocol.StatusFailed || !strings.Contains(res.Error, "read-only") || a.sends.Load() != 0 || desktop.prepares.Load() != 0 || desktop.sends.Load() != 0 {
				t.Fatalf("unsafe send route %q durable=%v: %+v", route, durable, res)
			}
			inspection := protocol.InspectTurnMessage{Type: "inspect_turn", NodeID: cfg.NodeID, CommandID: cmd.CommandID, SessionID: cmd.SessionID, TurnID: "fake-turn"}
			if observed := d.InspectTurn(context.Background(), inspection); observed.Status != protocol.StatusUncertain || a.inspections.Load() != 0 || desktop.inspections.Load() != 0 {
				t.Fatalf("terminal fabricated inspection: %+v", observed)
			}
			closeDaemon(t, d)
		}
	}
}

func TestTerminalHistoryAndDesktopAuthorityAreExcluded(t *testing.T) {
	a := &terminalRouteAdapter{}
	d := NewDaemon(&config.Config{NodeID: "node", DesktopSend: true}, a)
	s := terminalFixtureSession("one")
	var err error
	d.terminalSnapshot, err = normalizeTerminalSessions([]protocol.Session{s})
	if err != nil {
		t.Fatal(err)
	}
	d.sessionSnapshot = []protocol.Session{s, {ID: "native"}}
	desktop := &routedDesktopFixture{}
	d.desktopHistory = desktop
	msg := protocol.ReadHistoryMessage{Type: "read_history", NodeID: "node", RequestID: "request", SessionID: s.ID}
	if got := d.ReadHistory(context.Background(), msg); got.Error != protocol.HistoryUnavailable || got.History != nil || a.histories.Load() != 0 || desktop.calls != 0 {
		t.Fatalf("terminal gained history: %+v", got)
	}
	if ids := d.desktopSessionIDs(); !reflect.DeepEqual(ids, []string{"native"}) {
		t.Fatalf("desktop targets included terminal: %v", ids)
	}
	d.publishDesktop(s.ID, protocol.DesktopObservation{OwnerID: "fake-owner", Status: "idle", Availability: "available"}, nil)
	if _, exists := d.desktopSnapshot[s.ID]; exists {
		t.Fatal("terminal gained desktop projection")
	}
	d.sendReadiness[s.ID] = desktopReadinessRecord{Availability: protocol.SendAvailability{State: protocol.SendReady}}
	if jobs := d.readinessSweep(time.Now(), map[string]bool{}, 2, nil); len(jobs) != 0 {
		t.Fatal("terminal queued readiness")
	}
	if _, exists := d.sendReadiness[s.ID]; exists {
		t.Fatal("terminal retained forged readiness")
	}
}

type terminalProbeDesktop struct{ calls atomic.Int32 }

func (f *terminalProbeDesktop) Watch(ctx context.Context, _ []string, _ func(string, protocol.DesktopObservation)) error {
	<-ctx.Done()
	return ctx.Err()
}
func (f *terminalProbeDesktop) Snapshot(context.Context, []string, func(string, protocol.DesktopObservation)) error {
	f.calls.Add(1)
	return nil
}

func TestProbeTerminalOnlyAndDiscoverySingleFlight(t *testing.T) {
	d := NewDaemon(&config.Config{}, &refreshFixture{discover: func(context.Context) ([]protocol.Session, error) { return nil, errors.New("PRIVATE_CONTROL") }})
	d.sessionCatalog = &catalogFixture{discover: func(context.Context) ([]protocol.Session, error) { return nil, errors.New("PRIVATE_FILE") }}
	d.terminalObserver = &catalogFixture{discover: func(context.Context) ([]protocol.Session, error) {
		return []protocol.Session{terminalFixtureSession("one")}, nil
	}}
	desktop := &terminalProbeDesktop{}
	d.desktopObserver = desktop
	got, err := d.Probe(context.Background())
	if err != nil || !got.Sources.Terminal || got.Sources.Control || got.Sources.Catalog || got.Sources.Desktop || len(got.Sessions) != 1 || desktop.calls.Load() != 0 || strings.Contains(strings.Join(got.Warnings, ";"), "PRIVATE") {
		t.Fatalf("bad independent probe: %+v %v", got, err)
	}
	var active, maximum, calls atomic.Int32
	started := make(chan struct{}, 2)
	d.terminalObserver = &catalogFixture{discover: func(ctx context.Context) ([]protocol.Session, error) {
		calls.Add(1)
		n := active.Add(1)
		if n > maximum.Load() {
			maximum.Store(n)
		}
		defer active.Add(-1)
		started <- struct{}{}
		<-ctx.Done()
		return nil, ctx.Err()
	}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 2)
	go func() { _, err := d.discoverTerminal(ctx); done <- err }()
	<-started
	go func() { _, err := d.discoverTerminal(ctx); done <- err }()
	cancel()
	for range 2 {
		select {
		case err := <-done:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("lost cancellation: %v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("discovery cancellation not joined")
		}
	}
	if maximum.Load() != 1 || active.Load() != 0 {
		t.Fatalf("single-flight violated: maximum=%d active=%d calls=%d", maximum.Load(), active.Load(), calls.Load())
	}
}
