package client

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type resumeFixtureAdapter struct {
	receiptAdapter
	endpoint             string
	turnID               string
	err                  error
	resumes, inspections atomic.Int32
	beforeResume         func()
}

func (a *resumeFixtureAdapter) Endpoint() string { return a.endpoint }
func (a *resumeFixtureAdapter) ResumeSend(_ context.Context, _, _ string) (string, error) {
	a.resumes.Add(1)
	if a.beforeResume != nil {
		a.beforeResume()
	}
	return a.turnID, a.err
}
func (a *resumeFixtureAdapter) InspectTurn(_ context.Context, sessionID, turnID string) (codex.TurnObservation, error) {
	a.inspections.Add(1)
	if sessionID != "fixture-session" || turnID != "resume-turn" {
		return codex.TurnObservation{}, errors.New("inexact inspection")
	}
	return codex.TurnObservation{Status: "completed", Output: "exact resumed turn"}, nil
}

func resumeFixtureSession(now time.Time) protocol.Session {
	loaded := false
	return protocol.Session{ID: "fixture-session", Provider: codex.ProviderCodexApp, Status: "notLoaded", Loaded: &loaded,
		ObservedAt: now.UTC().Format(time.RFC3339Nano), Capabilities: []protocol.ActionType{protocol.ActionRead, protocol.CapabilityResumeSend}}
}

func resumeCommand() protocol.ControllerCommandMessage {
	cmd := persistenceCommand(time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano))
	cmd.SendRoute = protocol.RouteAppServerResume
	return cmd
}

func TestResumeRouteBindsBeforeMutationAndInspectsOriginalEndpoint(t *testing.T) {
	cfg := persistenceConfig(t.TempDir())
	a := &resumeFixtureAdapter{endpoint: cfg.SocketPath, turnID: "resume-turn"}
	d, err := OpenDaemon(cfg, a)
	if err != nil {
		t.Fatal(err)
	}
	d.sessionSnapshot = []protocol.Session{resumeFixtureSession(time.Now())}
	cmd := resumeCommand()
	a.beforeResume = func() {
		entry, found, err := d.journal.Lookup(cmd)
		if err != nil || !found || entry.Dispatch == nil || entry.Dispatch.Route != protocol.RouteAppServerResume ||
			entry.Dispatch.Endpoint != cfg.SocketPath || entry.Dispatch.SessionID != cmd.SessionID || entry.Finished {
			t.Errorf("resume before exact durable endpoint binding: %+v %v", entry, err)
		}
	}
	res := d.ExecuteCommand(context.Background(), cmd)
	if res.Status != protocol.StatusAccepted || res.TurnID != "resume-turn" || a.resumes.Load() != 1 || a.sends.Load() != 0 {
		t.Fatalf("unexpected resume route result: %+v", res)
	}
	if replay := d.ExecuteCommand(context.Background(), cmd); replay != res || a.resumes.Load() != 1 {
		t.Fatal("duplicate resumed and sent again")
	}
	if err := d.ackResult(protocol.ResultAckMessage{Type: "result_ack", CommandID: res.CommandID, TurnID: res.TurnID, Status: res.Status}); err != nil {
		t.Fatal(err)
	}
	closeDaemon(t, d)
	a.beforeResume = nil
	d, err = OpenDaemon(cfg, a)
	if err != nil {
		t.Fatal(err)
	}
	defer closeDaemon(t, d)
	if replay := d.ExecuteCommand(context.Background(), cmd); replay.Status != protocol.StatusAccepted || a.resumes.Load() != 1 {
		t.Fatal("restart replayed a resume")
	}
	msg := protocol.InspectTurnMessage{Type: "inspect_turn", CommandID: cmd.CommandID, NodeID: cmd.NodeID, SessionID: cmd.SessionID, TurnID: res.TurnID}
	if got := d.InspectTurn(context.Background(), msg); got.Status != protocol.StatusCompleted || got.Output != "exact resumed turn" {
		t.Fatalf("lost exact endpoint receipt: %+v", got)
	}
	msg.TurnID = "different-turn"
	if got := d.InspectTurn(context.Background(), msg); got.Status != protocol.StatusUncertain || a.inspections.Load() != 1 {
		t.Fatal("inexact turn reached runtime")
	}
	msg.TurnID = res.TurnID
	a.endpoint = "/changed/managed.sock"
	if got := d.InspectTurn(context.Background(), msg); got.Status != protocol.StatusUncertain || a.inspections.Load() != 1 {
		t.Fatal("changed adapter endpoint allowed inspection fallback")
	}
	a.endpoint, cfg.SocketPath = cfg.SocketPath, "/changed/config.sock"
	if got := d.InspectTurn(context.Background(), msg); got.Status != protocol.StatusUncertain || a.inspections.Load() != 1 {
		t.Fatal("changed configuration allowed inspection fallback")
	}
}

func TestResumeRouteFailureNeverFallsBackOrReplays(t *testing.T) {
	for _, tc := range []struct {
		name                       string
		err                        error
		turnID                     string
		bindFailure, finishFailure bool
		want                       protocol.DaemonResultStatus
		calls                      int32
	}{
		{name: "writer", err: errors.New("active writer already owns thread"), want: protocol.StatusFailed, calls: 1},
		{name: "bounded-writer", err: errors.New("active writer " + strings.Repeat("x", 2000)), want: protocol.StatusFailed, calls: 1},
		{name: "bind-failure", bindFailure: true, want: protocol.StatusUncertain},
		{name: "finish-failure", finishFailure: true, turnID: "resume-turn", want: protocol.StatusUncertain, calls: 1},
		{name: "lost-start-ack", err: &codex.UncertainError{Err: errors.New("disconnected")}, want: protocol.StatusUncertain, calls: 1},
		{name: "invalid-turn", turnID: "bad turn", want: protocol.StatusUncertain, calls: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := persistenceConfig(t.TempDir())
			a := &resumeFixtureAdapter{endpoint: cfg.SocketPath, turnID: tc.turnID, err: tc.err}
			d, err := OpenDaemon(cfg, a)
			if err != nil {
				t.Fatal(err)
			}
			d.sessionSnapshot = []protocol.Session{resumeFixtureSession(time.Now())}
			if tc.bindFailure {
				d.journal = &failedBindJournal{d.journal}
			}
			if tc.finishFailure {
				d.journal = &faultyJournal{commandJournal: d.journal, failFinish: true}
			}
			cmd := resumeCommand()
			res := d.ExecuteCommand(context.Background(), cmd)
			if res.Status != tc.want || a.resumes.Load() != tc.calls || a.sends.Load() != 0 {
				t.Fatalf("unsafe resume rejection: %+v resumes=%d native=%d", res, a.resumes.Load(), a.sends.Load())
			}
			if len(res.Error) > maxPersistedErrorBytes {
				t.Fatal("unbounded writer error")
			}
			if tc.name == "writer" && !strings.Contains(res.Error, tc.err.Error()) {
				t.Fatal("writer conflict reason hidden")
			}
			if replay := d.ExecuteCommand(context.Background(), cmd); replay.Status != res.Status || (!tc.finishFailure && replay != res) || a.resumes.Load() != tc.calls {
				t.Fatal("failed/uncertain resume executed again")
			}
			closeDaemon(t, d)
			d, err = OpenDaemon(cfg, a)
			if err != nil {
				t.Fatal(err)
			}
			defer closeDaemon(t, d)
			if got := d.ExecuteCommand(context.Background(), cmd); got.Status != tc.want || a.resumes.Load() != tc.calls {
				t.Fatal("restart replayed failed/uncertain mutation")
			}
		})
	}
}

func TestResumeCapabilityRequiresFreshManagedTargetAndNoAvailableOwner(t *testing.T) {
	for _, kind := range []string{"eligible", "idle-unloaded", "idle-loaded", "active-loaded", "unavailable-owner", "fresh-idle-owner", "fresh-active-owner", "fresh-unknown-owner", "stale-managed", "future-managed", "catalog-only", "loaded-notLoaded", "active", "unknown", "missing-capability", "endpoint-mismatch", "volatile"} {
		t.Run(kind, func(t *testing.T) {
			cfg := persistenceConfig(t.TempDir())
			a := &resumeFixtureAdapter{endpoint: cfg.SocketPath, turnID: "resume-turn"}
			d, err := OpenDaemon(cfg, a)
			if err != nil {
				t.Fatal(err)
			}
			defer closeDaemon(t, d)
			now := time.Now()
			session := resumeFixtureSession(now)
			d.sessionSnapshot = []protocol.Session{session}
			eligible := kind == "eligible" || kind == "idle-unloaded" || kind == "idle-loaded" || kind == "unavailable-owner"
			switch kind {
			case "idle-unloaded":
				d.sessionSnapshot[0].Status = "idle"
			case "idle-loaded":
				d.sessionSnapshot[0].Status = "idle"
				*d.sessionSnapshot[0].Loaded = true
				d.sessionSnapshot[0].Capabilities = append(d.sessionSnapshot[0].Capabilities, protocol.ActionSend)
			case "active-loaded":
				d.sessionSnapshot[0].Status = "active"
				*d.sessionSnapshot[0].Loaded = true
			case "unavailable-owner", "fresh-idle-owner", "fresh-active-owner", "fresh-unknown-owner":
				owner := idleReadinessObservation(now, 1)
				if kind == "unavailable-owner" {
					owner.Availability = "unavailable"
				}
				if kind == "fresh-active-owner" {
					owner.Status = "active"
				}
				if kind == "fresh-unknown-owner" {
					owner.Status = "unknown"
				}
				d.desktopSnapshot[session.ID] = owner
			case "stale-managed":
				d.sessionSnapshot[0].ObservedAt = now.Add(-2 * protocol.MaxSendAvailabilityAge).Format(time.RFC3339Nano)
			case "future-managed":
				d.sessionSnapshot[0].ObservedAt = now.Add(time.Minute).Format(time.RFC3339Nano)
			case "catalog-only":
				d.sessionSnapshot, d.catalogSnapshot = nil, []protocol.Session{session}
			case "loaded-notLoaded":
				*d.sessionSnapshot[0].Loaded = true
			case "active", "unknown":
				d.sessionSnapshot[0].Status = kind
			case "missing-capability":
				d.sessionSnapshot[0].Capabilities = []protocol.ActionType{protocol.ActionRead}
			case "endpoint-mismatch":
				a.endpoint = "/different.sock"
			case "volatile":
				d.durableJournal = false
			}
			for range 3 {
				got := d.cachedSessions()[0]
				if slices.Contains(got.Capabilities, protocol.CapabilityResumeSend) != eligible {
					t.Fatalf("incorrect resume capability: %+v", got)
				}
				if a.resumes.Load() != 0 || a.sends.Load() != 0 {
					t.Fatal("snapshot query mutated target")
				}
			}
			res := d.ExecuteCommand(context.Background(), resumeCommand())
			if eligible {
				if res.Status != protocol.StatusAccepted || a.resumes.Load() != 1 {
					t.Fatalf("explicit eligible send refused: %+v", res)
				}
			} else if res.Status != protocol.StatusFailed || a.resumes.Load() != 0 || a.sends.Load() != 0 {
				t.Fatalf("ineligible target mutated: %+v", res)
			}
		})
	}
}

func TestConcurrentDuplicateResumeCommandsMutateOnce(t *testing.T) {
	cfg := persistenceConfig(t.TempDir())
	a := &resumeFixtureAdapter{endpoint: cfg.SocketPath, turnID: "resume-turn"}
	d, err := OpenDaemon(cfg, a)
	if err != nil {
		t.Fatal(err)
	}
	defer closeDaemon(t, d)
	d.sessionSnapshot = []protocol.Session{resumeFixtureSession(time.Now())}
	cmd := resumeCommand()
	var callers sync.WaitGroup
	for range 20 {
		callers.Add(1)
		go func() {
			defer callers.Done()
			if got := d.ExecuteCommand(context.Background(), cmd); got.Status != protocol.StatusAccepted && got.Status != protocol.StatusUncertain {
				t.Errorf("duplicate result: %+v", got)
			}
		}()
	}
	callers.Wait()
	if a.resumes.Load() != 1 || a.sends.Load() != 0 {
		t.Fatalf("duplicate mutation: resumes=%d native=%d", a.resumes.Load(), a.sends.Load())
	}
}

func TestExistingRoutesNeverImplicitlyResume(t *testing.T) {
	for _, route := range []protocol.SendRoute{"", protocol.RouteControlSocket, protocol.RouteDesktopOwner} {
		t.Run(string(route), func(t *testing.T) {
			cfg := persistenceConfig(t.TempDir())
			a := &resumeFixtureAdapter{endpoint: cfg.SocketPath, turnID: "resume-turn"}
			d, err := OpenDaemon(cfg, a)
			if err != nil {
				t.Fatal(err)
			}
			defer closeDaemon(t, d)
			d.sessionSnapshot = []protocol.Session{resumeFixtureSession(time.Now())}
			cmd := resumeCommand()
			cmd.SendRoute = route
			d.ExecuteCommand(context.Background(), cmd)
			if a.resumes.Load() != 0 {
				t.Fatal("frozen legacy route fell back to resume")
			}
		})
	}
}

func TestFrozenResumeRouteContinuesAfterManagedTargetLoads(t *testing.T) {
	cfg := persistenceConfig(t.TempDir())
	a := &resumeFixtureAdapter{endpoint: cfg.SocketPath, turnID: "first-resumed-turn"}
	d, err := OpenDaemon(cfg, a)
	if err != nil {
		t.Fatal(err)
	}
	defer closeDaemon(t, d)
	d.sessionSnapshot = []protocol.Session{resumeFixtureSession(time.Now())}
	cmd := resumeCommand()
	a.beforeResume = func() {
		entry, found, err := d.journal.Lookup(cmd)
		if err != nil || !found || entry.Dispatch == nil || entry.Dispatch.Route != protocol.RouteAppServerResume || entry.Dispatch.Endpoint != cfg.SocketPath {
			t.Errorf("continuation bypassed bound original route: %+v %v", entry, err)
		}
	}
	first := d.ExecuteCommand(context.Background(), cmd)
	if first.Status != protocol.StatusAccepted {
		t.Fatalf("first send failed: %+v", first)
	}
	loaded := true
	d.sessionSnapshot[0].Loaded, d.sessionSnapshot[0].Status = &loaded, "idle"
	d.sessionSnapshot[0].ObservedAt = time.Now().UTC().Format(time.RFC3339Nano)
	d.sessionSnapshot[0].Capabilities = []protocol.ActionType{protocol.ActionRead, protocol.ActionSend, protocol.CapabilityResumeSend}
	if got := d.cachedSessions()[0]; !slices.Contains(got.Capabilities, protocol.CapabilityResumeSend) {
		t.Fatal("loaded inventory removed frozen-route continuation")
	}
	firstCommand := cmd
	cmd.CommandID, a.turnID = "continuation-command", "continuation-turn"
	second := d.ExecuteCommand(context.Background(), cmd)
	if second.Status != protocol.StatusAccepted || second.TurnID != "continuation-turn" || a.resumes.Load() != 2 || a.sends.Load() != 0 {
		t.Fatalf("loaded continuation failed or switched route: %+v", second)
	}
	if replay := d.ExecuteCommand(context.Background(), firstCommand); replay != first || a.resumes.Load() != 2 {
		t.Fatal("continuation reopened earlier command")
	}
	for _, receipt := range []protocol.DaemonResultMessage{first, second} {
		identity, err := d.journal.ReadDispatch(receipt.CommandID, cmd.SessionID, receipt.TurnID)
		if err != nil || identity.Route != protocol.RouteAppServerResume || identity.Endpoint != cfg.SocketPath {
			t.Fatalf("continuation changed route or endpoint: %+v %v", identity, err)
		}
	}
}
