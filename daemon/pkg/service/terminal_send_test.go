package service

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
)

func TestTerminalSendServiceModePreservedAndRejectedBeforeWrites(t *testing.T) {
	cfg := sampleConfig(t, t.TempDir())
	cfg.TerminalSocketPath, cfg.TerminalPanes = "/fixture/terminal.sock", []string{"w1:p1"}
	for _, mode := range []string{"", "non-atomic"} {
		cfg.TerminalSendMode = mode
		for _, render := range []func(string, *config.Config, string) (string, error){GeneratePlistXML, GenerateSystemdUnit} {
			body, err := render("/fixture/daemon", cfg, "/fixture/token")
			if err != nil || strings.Contains(body, "--terminal-send-mode") != (mode != "") {
				t.Fatalf("mode %q changed: %s %v", mode, body, err)
			}
		}
	}
	dir := t.TempDir()
	cfg.TerminalSendMode = "atomic"
	runner := &fakeRunner{}
	for _, install := range []func(context.Context, *config.Config) error{(&DarwinManager{HomeDir: dir, Runner: runner}).Install, (&LinuxManager{HomeDir: dir, Runner: runner}).Install} {
		if err := install(context.Background(), cfg); err == nil || !strings.Contains(err.Error(), "terminal-send-mode") {
			t.Fatalf("mode not rejected first: %v", err)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 || len(runner.calls) != 0 {
		t.Fatal("invalid mode caused side effects")
	}
}
