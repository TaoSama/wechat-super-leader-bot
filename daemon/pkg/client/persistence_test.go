package client

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/journal"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type receiptAdapter struct{ sends atomic.Int32 }

func (a *receiptAdapter) DiscoverSessions(context.Context) ([]protocol.Session, error) {
	return nil, nil
}
func (a *receiptAdapter) ReadSession(context.Context, string) (string, error) {
	return "fixture read", nil
}
func (a *receiptAdapter) SendPrompt(context.Context, string, string) (string, error) {
	a.sends.Add(1)
	return "turnId=durable-turn", nil
}

func persistenceConfig(dir string) *config.Config {
	return &config.Config{NodeID: "macair", ControllerURL: "ws://127.0.0.1:8790/v1/daemon", SocketPath: "/test/socket", StateDir: filepath.Join(dir, "state")}
}
func persistenceCommand(expiry string) protocol.ControllerCommandMessage {
	return protocol.ControllerCommandMessage{
		Type: "command", CommandID: "durable-command", NodeID: "macair", SessionID: "fixture-session", Action: protocol.ActionSend, Prompt: "fixture only", ExpiresAt: expiry,
	}
}
func closeDaemon(t *testing.T, d *Daemon) {
	t.Helper()
	if err := d.Close(); err != nil {
		t.Fatal(err)
	}
}

// The subprocess exits without closing the journal to exercise OS file-lock
// release and committed receipts, not merely a clean in-process reopen.
func TestJournalCrashHelper(t *testing.T) {
	mode := os.Getenv("SUPER_LEADER_JOURNAL_CRASH_TEST")
	if mode == "" {
		t.Skip("subprocess helper")
	}
	d, err := OpenDaemon(persistenceConfig(os.Getenv("SUPER_LEADER_JOURNAL_TEST_DIR")), &receiptAdapter{})
	if err != nil {
		t.Fatal(err)
	}
	cmd := persistenceCommand(os.Getenv("SUPER_LEADER_JOURNAL_TEST_EXPIRY"))
	switch mode {
	case "claim":
		if _, created, err := d.journal.Begin(cmd); err != nil || !created {
			t.Fatalf("claim: %v", err)
		}
	case "accepted":
		if result := d.ExecuteCommand(context.Background(), cmd); result.Status != protocol.StatusAccepted {
			t.Fatalf("dispatch: %+v", result)
		}
	case "full-output":
		if _, created, err := d.journal.Begin(cmd); err != nil || !created {
			t.Fatalf("claim: %v", err)
		}
		if err := d.journal.Finish(protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID,
			Status: protocol.StatusCompleted, TurnID: "durable-turn", Output: fullOutputFixture()}); err != nil {
			t.Fatal(err)
		}
	default:
		t.Fatal("invalid helper mode")
	}
	os.Exit(17)
}

func TestDurableReceiptAfterProcessExit(t *testing.T) {
	for _, mode := range []string{"claim", "accepted", "full-output"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			expiry := time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)
			child := exec.Command(os.Args[0], "-test.run=^TestJournalCrashHelper$")
			child.Env = append(os.Environ(), "SUPER_LEADER_JOURNAL_CRASH_TEST="+mode, "SUPER_LEADER_JOURNAL_TEST_DIR="+dir, "SUPER_LEADER_JOURNAL_TEST_EXPIRY="+expiry)
			output, err := child.CombinedOutput()
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() != 17 {
				t.Fatalf("crash helper: %v %s", err, output)
			}
			adapter := &receiptAdapter{}
			d, err := OpenDaemon(persistenceConfig(dir), adapter)
			if err != nil {
				t.Fatal(err)
			}
			want := protocol.StatusAccepted
			if mode == "claim" {
				want = protocol.StatusUncertain
			} else if mode == "full-output" {
				want = protocol.StatusCompleted
			}
			result := d.ExecuteCommand(context.Background(), persistenceCommand(expiry))
			if result.Status != want || adapter.sends.Load() != 0 {
				t.Fatalf("unsafe recovery: %+v sends=%d", result, adapter.sends.Load())
			}
			var replay []protocol.DaemonResultMessage
			if err := d.flushResults(func(msg any) error { replay = append(replay, msg.(protocol.DaemonResultMessage)); return nil }); err != nil {
				t.Fatal(err)
			}
			if len(replay) != 1 || replay[0].Status != want {
				t.Fatalf("missing durable outbox: %+v", replay)
			}
			if mode == "accepted" && replay[0].TurnID != "durable-turn" {
				t.Fatal("turn ID lost")
			}
			if mode == "full-output" && (result.Output != fullOutputFixture() || replay[0].Output != fullOutputFixture()) {
				t.Fatal("full original Markdown was lost after process exit")
			}
			if err := d.ackResult(protocol.ResultAckMessage{Type: "result_ack", CommandID: result.CommandID, Status: result.Status, TurnID: result.TurnID}); err != nil {
				t.Fatal(err)
			}
			closeDaemon(t, d)
			d, err = OpenDaemon(persistenceConfig(dir), adapter)
			if err != nil {
				t.Fatal(err)
			}
			defer closeDaemon(t, d)
			if pending, err := d.journal.Unacked(); err != nil || len(pending) != 0 {
				t.Fatalf("ack not persisted: %v %v", pending, err)
			}
			if d.ExecuteCommand(context.Background(), persistenceCommand(expiry)).Status != want || adapter.sends.Load() != 0 {
				t.Fatal("ack erased replay protection")
			}
		})
	}
}

func fullOutputFixture() string {
	return "\n# 完整结果\n\n```go\n" + strings.Repeat("\t// 原始 Markdown <>& 🎉  \n", 10000) + "```\n\n"
}

type faultyJournal struct {
	commandJournal
	failBegin  bool
	failFinish bool
}

func (f *faultyJournal) Begin(cmd protocol.ControllerCommandMessage) (journal.Entry, bool, error) {
	if f.failBegin {
		return journal.Entry{}, false, errors.New("fixture disk failure")
	}
	return f.commandJournal.Begin(cmd)
}
func (f *faultyJournal) Finish(res protocol.DaemonResultMessage) error {
	if f.failFinish {
		return errors.New("fixture disk failure")
	}
	return f.commandJournal.Finish(res)
}

func TestJournalWriteFailuresNeverRepeatDispatch(t *testing.T) {
	a := &receiptAdapter{}
	d, err := OpenDaemon(persistenceConfig(t.TempDir()), a)
	if err != nil {
		t.Fatal(err)
	}
	defer closeDaemon(t, d)
	fault := &faultyJournal{commandJournal: d.journal, failBegin: true}
	d.journal = fault
	cmd := persistenceCommand(time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano))
	if d.ExecuteCommand(context.Background(), cmd).Status != protocol.StatusUncertain || a.sends.Load() != 0 {
		t.Fatal("dispatched without durable claim")
	}
	fault.failBegin = false
	fault.failFinish = true
	if d.ExecuteCommand(context.Background(), cmd).Status != protocol.StatusUncertain || a.sends.Load() != 1 {
		t.Fatal("unexpected result after save failure")
	}
	if d.ExecuteCommand(context.Background(), cmd).Status != protocol.StatusUncertain || a.sends.Load() != 1 {
		t.Fatal("replayed claimed command")
	}
	if err := d.flushResults(func(any) error { t.Fatal("unpersisted result sent"); return nil }); err == nil {
		t.Fatal("save failure ignored")
	}
	fault.failFinish = false
	var result protocol.DaemonResultMessage
	if err := d.flushResults(func(msg any) error { result = msg.(protocol.DaemonResultMessage); return nil }); err != nil {
		t.Fatal(err)
	}
	if result.Status != protocol.StatusAccepted || result.TurnID != "durable-turn" || a.sends.Load() != 1 {
		t.Fatalf("failed receipt recovery: %+v", result)
	}
}

func TestReceiptBoundsAndPrivateFile(t *testing.T) {
	text := boundedReceiptText(strings.Repeat("界", 20000), maxPersistedErrorBytes)
	if len(text) > maxPersistedErrorBytes || !utf8.ValidString(text) || !strings.HasSuffix(text, "...(truncated)") {
		t.Fatal("invalid UTF8 bound")
	}
	dir := t.TempDir()
	d, err := OpenDaemon(persistenceConfig(dir), &receiptAdapter{})
	if err != nil {
		t.Fatal(err)
	}
	defer closeDaemon(t, d)
	info, err := os.Stat(filepath.Join(persistenceConfig(dir).StateDir, journal.FileName))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("unsafe journal mode: %v", info.Mode())
	}
}

func TestCompleteResultReceiptRetainsOutputAndRejectsOverflow(t *testing.T) {
	for _, length := range []int{256 * 1024, protocol.MaxTurnOutputBytes, protocol.MaxTurnOutputBytes + 1} {
		original := strings.Repeat("<", length)
		result := completeResultReceipt(protocol.DaemonResultMessage{
			Type: "result", CommandID: "full-receipt", Status: protocol.StatusCompleted,
			Output: original, OutputPresent: true,
		})
		if length > protocol.MaxTurnOutputBytes {
			if result.Status != protocol.StatusFailed || result.Output != "" || result.OutputPresent || result.Error != protocol.ErrTurnOutputLimit.Error() {
				t.Fatalf("over-limit receipt must fail explicitly: status=%s output=%d error=%s", result.Status, len(result.Output), result.Error)
			}
		} else if result.Status != protocol.StatusCompleted || result.Output != original || !result.OutputPresent {
			t.Fatalf("receipt modified: input=%d output=%d status=%s", length, len(result.Output), result.Status)
		}
	}
}

type fullResultAdapter struct {
	receiptAdapter
	output string
}

func (a *fullResultAdapter) ReadSession(context.Context, string) (string, error) {
	return a.output, nil
}

func TestExecuteCommandDurablyStoresFullOutputOrExplicitFailure(t *testing.T) {
	for _, tooLarge := range []bool{false, true} {
		name, output := "complete-markdown", fullOutputFixture()
		if tooLarge {
			name, output = "explicit-overflow", strings.Repeat("x", protocol.MaxTurnOutputBytes+1)
		}
		t.Run(name, func(t *testing.T) {
			d, err := OpenDaemon(persistenceConfig(t.TempDir()), &fullResultAdapter{output: output})
			if err != nil {
				t.Fatal(err)
			}
			defer closeDaemon(t, d)
			cmd := persistenceCommand(time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano))
			cmd.Action, cmd.Prompt = protocol.ActionRead, ""
			result := d.ExecuteCommand(context.Background(), cmd)
			if tooLarge {
				if result.Status != protocol.StatusFailed || result.HasOutput() || result.Error != protocol.ErrTurnOutputLimit.Error() {
					t.Fatalf("overflow must explicitly fail: status=%s output=%d error=%s", result.Status, len(result.Output), result.Error)
				}
			} else if result.Status != protocol.StatusCompleted || result.Output != output {
				t.Fatalf("full result changed: status=%s len=%d want=%d", result.Status, len(result.Output), len(output))
			}
			if err := d.flushResults(func(msg any) error {
				replay := msg.(protocol.DaemonResultMessage)
				if !protocol.SameResult(result, replay) {
					t.Error("durable replay changed original result")
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		})
	}
}
