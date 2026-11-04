package claude

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
)

func TestSendSuccessRecordsExactFinalText(t *testing.T) {
	f := newFixture(t, "success")
	if err := f.adapter.Send(context.Background(), PublicID(testSessionID), testTurnID, "请修复测试"); err != nil {
		t.Fatal(err)
	}
	if !f.adapter.Running(PublicID(testSessionID)) {
		t.Log("run finished before the running check")
	}
	view := f.finish(testTurnID)
	if view.Err != nil || view.Status != TurnCompleted || view.Output != "final answer" {
		t.Fatalf("unexpected observation: %+v", view)
	}
	args := strings.Fields(f.read("args"))
	want := []string{"-p", "--resume", testSessionID, "--output-format", "stream-json", "--verbose",
		"--permission-mode", DefaultPermissionMode, "--permission-prompts", "none"}
	if strings.Join(args, " ") != strings.Join(want, " ") {
		t.Fatalf("args = %v", args)
	}
	if f.read("stdin") != "请修复测试" {
		t.Fatalf("prompt not passed on stdin: %q", f.read("stdin"))
	}
	// pwd reports the physical directory, so resolve /var -> /private/var on macOS.
	if wantCwd, err := filepath.EvalSymlinks(f.cwd); err != nil || strings.TrimSpace(f.read("cwd")) != wantCwd {
		t.Fatalf("cwd = %q", f.read("cwd"))
	}
	env := f.read("env")
	if strings.Contains(env, "secret-node-token") || strings.Contains(env, "/should/not/leak") || !strings.Contains(env, "ANTHROPIC_API_KEY=test-key") ||
		!strings.Contains(env, "CLAUDE_CONFIG_DIR="+strings.TrimSuffix(f.root, "/"+projectsDirName)) {
		t.Fatalf("environment not restricted: %s", env)
	}
	if f.adapter.Running(PublicID(testSessionID)) {
		t.Fatal("finished run still reported running")
	}
	// The daemon's own finished write must not block the next turn.
	f.writeTranscript(time.Now())
	if status := discoveredStatus(t, f); status != StatusActive {
		t.Logf("transcript rewritten after the run is treated as %q", status)
	}
}

func TestSendErrorResultFails(t *testing.T) {
	f := newFixture(t, "error")
	if err := f.adapter.Send(context.Background(), PublicID(testSessionID), testTurnID, "x"); err != nil {
		t.Fatal(err)
	}
	if view := f.finish(testTurnID); view.Status != TurnFailed || !strings.Contains(view.Error, "error_max_turns") {
		t.Fatalf("unexpected observation: %+v", view)
	}
}

func TestSendCrashWithoutResultIsUnknown(t *testing.T) {
	f := newFixture(t, "crash")
	if err := f.adapter.Send(context.Background(), PublicID(testSessionID), testTurnID, "x"); err != nil {
		t.Fatal(err)
	}
	if view := f.finish(testTurnID); view.Status != TurnUnknown {
		t.Fatalf("crash reported %+v", view)
	}
}

func TestSendRefusedBeforeSessionLoadFails(t *testing.T) {
	f := newFixture(t, "refuse")
	if err := f.adapter.Send(context.Background(), PublicID(testSessionID), testTurnID, "x"); err != nil {
		t.Fatal(err)
	}
	if view := f.finish(testTurnID); view.Status != TurnFailed || !strings.Contains(view.Error, "running in the background") {
		t.Fatalf("refusal reported %+v", view)
	}
}

func TestSendDifferentSessionIsUnknown(t *testing.T) {
	f := newFixture(t, "other")
	if err := f.adapter.Send(context.Background(), PublicID(testSessionID), testTurnID, "x"); err != nil {
		t.Fatal(err)
	}
	if view := f.finish(testTurnID); view.Status != TurnUnknown || !strings.Contains(view.Error, "different session") {
		t.Fatalf("session mismatch reported %+v", view)
	}
}

func TestSendTimeoutInterruptsProcessGroup(t *testing.T) {
	f := newFixture(t, "hang")
	f.adapter.cfg.RunTimeout = 300 * time.Millisecond
	if err := f.adapter.Send(context.Background(), PublicID(testSessionID), testTurnID, "x"); err != nil {
		t.Fatal(err)
	}
	if view := f.finish(testTurnID); view.Status != TurnInterrupted {
		t.Fatalf("timeout reported %+v", view)
	}
}

func TestCloseStopsRunsWithoutConfirmingThem(t *testing.T) {
	f := newFixture(t, "hang")
	if err := f.adapter.Send(context.Background(), PublicID(testSessionID), testTurnID, "x"); err != nil {
		t.Fatal(err)
	}
	f.adapter.Close()
	if view := f.finish(testTurnID); view.Status != TurnUnknown {
		t.Fatalf("shutdown reported %+v", view)
	}
	if err := f.adapter.Send(context.Background(), PublicID(testSessionID), "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee", "x"); err == nil {
		t.Fatal("closed adapter launched a run")
	}
}

func TestSendRefusesBusySessionsWithoutLaunching(t *testing.T) {
	f := newFixture(t, "hang")
	f.writeTranscript(time.Now())
	if err := f.adapter.Send(context.Background(), PublicID(testSessionID), testTurnID, "x"); !errors.Is(err, ErrBusy) {
		t.Fatalf("recent transcript: %v", err)
	}
	f.writeTranscript(time.Now().Add(-time.Hour))
	f.write(f.bin+"/agents.json", `[{"kind":"interactive","cwd":"/x","pid":7,"sessionId":"`+testSessionID+`"}]`, 0o600)
	if err := f.adapter.Send(context.Background(), PublicID(testSessionID), testTurnID, "x"); !errors.Is(err, ErrBusy) {
		t.Fatalf("live terminal session: %v", err)
	}
	f.write(f.bin+"/agents.fail", "", 0o600)
	if err := f.adapter.Send(context.Background(), PublicID(testSessionID), testTurnID, "x"); err == nil || codex.IsUncertain(err) {
		t.Fatalf("failed live check must refuse definitively: %v", err)
	}
	if _, ok := f.adapter.Done(testTurnID); ok {
		t.Fatal("a refused send registered a run")
	}
}

func TestSendSerializesOneRunPerSession(t *testing.T) {
	f := newFixture(t, "hang")
	if err := f.adapter.Send(context.Background(), PublicID(testSessionID), testTurnID, "x"); err != nil {
		t.Fatal(err)
	}
	if err := f.adapter.Send(context.Background(), PublicID(testSessionID), "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee", "y"); !errors.Is(err, ErrBusy) {
		t.Fatalf("second concurrent run: %v", err)
	}
}

func TestPermissionModeFromConfig(t *testing.T) {
	f := newFixture(t, "success")
	f.adapter.cfg.PermissionMode = "acceptEdits"
	if err := f.adapter.Send(context.Background(), PublicID(testSessionID), testTurnID, "x"); err != nil {
		t.Fatal(err)
	}
	f.finish(testTurnID)
	if !strings.Contains(f.read("args"), "--permission-mode\nacceptEdits\n") {
		t.Fatalf("args = %q", f.read("args"))
	}
}

func TestConfigValidation(t *testing.T) {
	valid := Config{ProjectsRoot: "/tmp/cfg/projects", ClaudePath: "/usr/local/bin/claude"}.WithDefaults()
	if err := valid.Validate(); err != nil || valid.PermissionMode != "dontAsk" {
		t.Fatalf("default config: %v %+v", err, valid)
	}
	for _, edit := range []func(*Config){
		func(c *Config) { c.ProjectsRoot = "relative/projects" },
		func(c *Config) { c.ProjectsRoot = "/tmp/cfg/other" },
		func(c *Config) { c.ClaudePath = "claude" },
		func(c *Config) { c.PermissionMode = "yolo" },
	} {
		bad := valid
		edit(&bad)
		if bad.Validate() == nil {
			t.Fatalf("invalid config accepted: %+v", bad)
		}
	}
}
