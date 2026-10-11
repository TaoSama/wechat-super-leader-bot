package client

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/journal"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/skills"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/terminal"
)

func openTerminalSender(t *testing.T, h *terminalSendHost) (*Daemon, *terminalRouteAdapter) {
	t.Helper()
	cfg := persistenceConfig(t.TempDir())
	cfg.TerminalSocketPath, cfg.TerminalPanes, cfg.TerminalSendMode = h.socket, []string{"w1:p1"}, protocol.TerminalNonAtomicMode
	a := &terminalRouteAdapter{}
	d, err := OpenDaemon(cfg, a)
	if err != nil {
		t.Fatal(err)
	}
	d.refreshTerminalSnapshot(context.Background(), nil)
	if len(d.cachedSessions()) != 1 {
		closeDaemon(t, d)
		t.Fatal("no synthetic terminal discovered")
	}
	return d, a
}

func terminalSendCommand(d *Daemon) protocol.ControllerCommandMessage {
	cmd := persistenceCommand(time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano))
	cmd.SessionID, cmd.SendRoute, cmd.Prompt = d.cachedSessions()[0].ID, protocol.RouteTerminalPane, "  中文输入\n第二行\t原文 e\u0301 "
	return cmd
}

func TestTerminalSendDurableExactInputReplayAndAck(t *testing.T) {
	h := newTerminalSendHost(t, false, nil)
	d, a := openTerminalSender(t, h)
	cmd := terminalSendCommand(d)
	sender := d
	h.mu.Lock()
	h.onPrompt = func() {
		entry, found, err := sender.journal.Lookup(cmd)
		if err != nil || !found || entry.Finished || entry.TerminalDelivery == nil || entry.TerminalDelivery.Endpoint != h.socket || entry.TerminalDelivery.PaneID != "w1:p1" || entry.TerminalDelivery.PromptSHA256 == "" {
			t.Errorf("prompt before durable binding: %+v %v", entry, err)
		}
	}
	h.mu.Unlock()
	res := d.ExecuteCommand(context.Background(), cmd)
	if res.Status != protocol.StatusInputWritten || res.InputReceipt == nil || res.Output != "" || res.TurnID != "" || res.Error != "" || h.prompt() != cmd.Prompt || a.sends.Load() != 0 {
		t.Fatalf("wrong result: %+v", res)
	}
	digest := sha256.Sum256([]byte(cmd.Prompt))
	if res.InputReceipt.PromptSHA256 != fmt.Sprintf("%x", digest) {
		t.Fatal("digest not raw input")
	}
	if repeat := d.ExecuteCommand(context.Background(), cmd); !protocol.SameResult(repeat, res) || h.count("agent.prompt") != 1 {
		t.Fatalf("repeat: %+v", repeat)
	}
	conflict := cmd
	conflict.Prompt = "different"
	if result := d.ExecuteCommand(context.Background(), conflict); result.Status != protocol.StatusUncertain || h.count("agent.prompt") != 1 {
		t.Fatal("conflict resent input")
	}
	wrongProof := *res.InputReceipt
	wrongProof.ObservedRevision++
	wrong := protocol.ResultAckMessage{Type: "result_ack", CommandID: cmd.CommandID, Status: res.Status, InputReceipt: &wrongProof}
	wire, err := json.Marshal(wrong)
	if err != nil {
		t.Fatal(err)
	}
	if err := d.handleTrackingMessage(context.Background(), "result_ack", wire, func(any) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if pending, err := d.journal.Unacked(); err != nil || len(pending) != 1 {
		t.Fatal("wrong ACK removed proof")
	}
	// Reopening the same journal replays the proof but never prepares or sends.
	cfg := d.cfg
	closeDaemon(t, d)
	d, err = OpenDaemon(cfg, a)
	if err != nil {
		t.Fatal(err)
	}
	defer closeDaemon(t, d)
	beforeGets := h.count("agent.get")
	if repeat := d.ExecuteCommand(context.Background(), cmd); !protocol.SameResult(repeat, res) || h.count("agent.get") != beforeGets || h.count("agent.prompt") != 1 {
		t.Fatal("restart re-executed instead of replaying")
	}
	var replay []protocol.DaemonResultMessage
	if err := d.flushResults(func(value any) error { replay = append(replay, value.(protocol.DaemonResultMessage)); return nil }); err != nil || len(replay) != 1 || !protocol.SameResult(replay[0], res) {
		t.Fatalf("replay: %+v %v", replay, err)
	}
	good := protocol.ResultAckMessage{Type: "result_ack", CommandID: cmd.CommandID, Status: res.Status, InputReceipt: res.InputReceipt}
	wire, err = json.Marshal(good)
	if err != nil {
		t.Fatal(err)
	}
	if err := d.handleTrackingMessage(context.Background(), "result_ack", wire, func(any) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if pending, err := d.journal.Unacked(); err != nil || len(pending) != 0 {
		t.Fatal("exact ACK not committed")
	}
	if repeat := d.ExecuteCommand(context.Background(), cmd); repeat.Status != protocol.StatusInputWritten || h.count("agent.prompt") != 1 {
		t.Fatal("ACK removed execution guard")
	}
}

type terminalFaultJournal struct {
	commandJournal
	failBind  bool
	afterBind func()
}

func (f *terminalFaultJournal) BindTerminal(cmd protocol.ControllerCommandMessage, identity terminal.DeliveryIdentity) error {
	if f.failBind {
		return errors.New("synthetic journal bind failure")
	}
	if err := f.commandJournal.BindTerminal(cmd, identity); err != nil {
		return err
	}
	if f.afterBind != nil {
		f.afterBind()
	}
	return nil
}

func TestTerminalSendPreflightBindExpiryAndCancelZeroInput(t *testing.T) {
	for _, mode := range []string{"binding-changed", "revision-changed", "bind-failed", "cancel-after-bind", "expiry-after-bind"} {
		t.Run(mode, func(t *testing.T) {
			h := newTerminalSendHost(t, false, func(n int, a map[string]any) {
				if n == 3 && mode == "binding-changed" {
					a["agent_session"].(map[string]any)["value"] = "changed"
				}
				if n == 3 && mode == "revision-changed" {
					a["revision"] = 11
				}
			})
			d, a := openTerminalSender(t, h)
			defer closeDaemon(t, d)
			cmd := terminalSendCommand(d)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			fault := &terminalFaultJournal{commandJournal: d.journal, failBind: mode == "bind-failed"}
			if mode == "cancel-after-bind" {
				fault.afterBind = cancel
			}
			if mode == "expiry-after-bind" {
				expiry := time.Now().Add(80 * time.Millisecond)
				cmd.ExpiresAt = expiry.Format(time.RFC3339Nano)
				fault.afterBind = func() { timer := time.NewTimer(time.Until(expiry)); defer timer.Stop(); <-timer.C }
			}
			d.journal = fault
			res := d.ExecuteCommand(ctx, cmd)
			if res.Status != protocol.StatusFailed || res.InputReceipt != nil || h.count("agent.prompt") != 0 || a.sends.Load() != 0 {
				t.Fatalf("not zero input: %+v", res)
			}
			if replay := d.ExecuteCommand(context.Background(), cmd); replay.Status != protocol.StatusFailed || h.count("agent.prompt") != 0 {
				t.Fatal("failed claim replayed")
			}
		})
	}
}

func TestTerminalSendLostReceiptAndFinishFailureNeverResend(t *testing.T) {
	for _, mode := range []string{"lost", "finish-failed"} {
		t.Run(mode, func(t *testing.T) {
			h := newTerminalSendHost(t, mode == "lost", nil)
			d, _ := openTerminalSender(t, h)
			defer closeDaemon(t, d)
			cmd := terminalSendCommand(d)
			fault := &faultyJournal{commandJournal: d.journal, failFinish: mode == "finish-failed"}
			d.journal = fault
			res := d.ExecuteCommand(context.Background(), cmd)
			if res.Status != protocol.StatusUncertain || res.InputReceipt != nil || h.count("agent.prompt") != 1 {
				t.Fatalf("not uncertain: %+v", res)
			}
			if res := d.ExecuteCommand(context.Background(), cmd); res.Status != protocol.StatusUncertain || h.count("agent.prompt") != 1 {
				t.Fatal("uncertain input resent")
			}
			fault.failFinish = false
			var saved protocol.DaemonResultMessage
			if err := d.flushResults(func(value any) error { saved = value.(protocol.DaemonResultMessage); return nil }); err != nil {
				t.Fatal(err)
			}
			want := protocol.StatusUncertain
			if mode == "finish-failed" {
				want = protocol.StatusInputWritten
			}
			if saved.Status != want || h.count("agent.prompt") != 1 {
				t.Fatal("result save retry repeated side effect")
			}
		})
	}
}

func TestTerminalSendDefaultVolatileAndWrongRouteRejected(t *testing.T) {
	h := newTerminalSendHost(t, false, nil)
	d, a := openTerminalSender(t, h)
	defer closeDaemon(t, d)
	for index, mode := range []string{"default", "volatile", "fixture-journal", "wrong-native-route", "wrong-terminal-route"} {
		cmd := terminalSendCommand(d)
		cmd.CommandID = fmt.Sprintf("blocked-%d", index)
		target := d
		switch mode {
		case "default":
			cfg := *d.cfg
			cfg.TerminalSendMode = ""
			cfg.StateDir = filepath.Join(t.TempDir(), "state")
			var err error
			target, err = OpenDaemon(&cfg, a)
			if err != nil {
				t.Fatal(err)
			}
			defer closeDaemon(t, target)
		case "volatile":
			target = NewDaemon(d.cfg, a)
		case "fixture-journal":
			target = NewDaemon(d.cfg, a)
			target.journal = d.journal
		case "wrong-native-route":
			cmd.SessionID = "native"
		case "wrong-terminal-route":
			cmd.SendRoute = protocol.RouteControlSocket
		}
		if res := target.ExecuteCommand(context.Background(), cmd); res.Status != protocol.StatusFailed || h.count("agent.prompt") != 0 || a.sends.Load() != 0 {
			t.Fatalf("mode %s: %+v", mode, res)
		}
	}
}

func TestTerminalSendConcurrentDuplicateAndSkillDigest(t *testing.T) {
	h := newTerminalSendHost(t, false, nil)
	d, _ := openTerminalSender(t, h)
	defer closeDaemon(t, d)
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "SKILL.md"), []byte("---\nname: synthetic-input\ndescription: synthetic input test\n---\n保持原文。\n"), 0600); err != nil {
		t.Fatal(err)
	}
	d.cfg.SkillRoots = []string{root}
	catalog, err := skills.Scan(d.cfg.SkillRoots)
	if err != nil || len(catalog) != 1 {
		t.Fatalf("skill fixture: %+v %v", catalog, err)
	}
	cmd := terminalSendCommand(d)
	cmd.Skills = []skills.Ref{{ID: catalog[0].ID, Digest: catalog[0].Digest}}
	expected, err := d.prepareSkillPrompt(cmd)
	if err != nil {
		t.Fatal(err)
	}
	const callers = 20
	results := make(chan protocol.DaemonResultMessage, callers)
	var workers sync.WaitGroup
	for range callers {
		workers.Add(1)
		go func() { defer workers.Done(); results <- d.ExecuteCommand(context.Background(), cmd) }()
	}
	workers.Wait()
	close(results)
	written := 0
	for res := range results {
		if res.Status == protocol.StatusInputWritten {
			written++
			sum := sha256.Sum256([]byte(expected))
			if res.InputReceipt.PromptSHA256 != fmt.Sprintf("%x", sum) {
				t.Fatal("digest excluded skills")
			}
		} else if res.Status != protocol.StatusUncertain {
			t.Fatalf("unexpected duplicate: %+v", res)
		}
	}
	if written == 0 || h.count("agent.prompt") != 1 || h.prompt() != expected || !strings.HasSuffix(h.prompt(), cmd.Prompt) {
		t.Fatal("combined skill text changed or duplicated")
	}
}

func TestTerminalReadinessIndependentZeroInputAndExpiration(t *testing.T) {
	h := newTerminalSendHost(t, false, nil)
	d, _ := openTerminalSender(t, h)
	defer closeDaemon(t, d)
	initial := d.cachedSessions()[0]
	if initial.SendAvailability == nil || initial.SendAvailability.State == protocol.SendReady || initial.Loaded == nil || *initial.Loaded {
		t.Fatal("observation alone granted readiness")
	}
	ctx, cancel := context.WithCancel(context.Background())
	updates := make(chan struct{}, 4)
	done := make(chan struct{})
	go func() { defer close(done); d.refreshTerminalReadiness(ctx, updates) }()
	defer func() { cancel(); <-done }()
	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	for {
		select {
		case <-updates:
			availability := d.cachedSessions()[0].SendAvailability
			if availability.State != protocol.SendReady {
				continue
			}
			if availability.Route != protocol.RouteTerminalPane || availability.Mode != protocol.TerminalNonAtomicMode || h.count("agent.prompt") != 0 {
				t.Fatal("probe mutated or used wrong route")
			}
			if pending, err := d.journal.Unacked(); err != nil || len(pending) != 0 {
				t.Fatal("probe claimed a command")
			}
			observed, err := time.Parse(time.RFC3339Nano, availability.ObservedAt)
			if err != nil {
				t.Fatal(err)
			}
			d.snapshotMu.Lock()
			late := d.terminalAvailabilityLocked(d.terminalSnapshot[0], observed.Add(protocol.MaxSendAvailabilityAge))
			d.snapshotMu.Unlock()
			if late.State == protocol.SendReady {
				t.Fatal("expired readiness remained ready")
			}
			return
		case <-deadline.C:
			t.Fatal("independent probe did not complete")
		}
	}
}

// Keep this compile-time assertion next to the failure-injection journal.
var _ commandJournal = (*journal.Journal)(nil)
