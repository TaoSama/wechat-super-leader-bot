package service

import (
	"context"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
)

func TestServiceHistoryRootsRoundTripWithoutImplicitInput(t *testing.T) {
	cfg := sampleConfig(t, t.TempDir())
	cfg.TerminalSocketPath, cfg.TerminalPanes = "/fixture/host.sock", []string{"w2:p3"}
	cfg.TerminalHistoryRoots = map[string]string{"grok": "/fixture/grok sessions", "codex": "/fixture/$codex% & records"}
	body, err := GeneratePlistXML("/fixture/daemon", cfg, "/fixture/token")
	if err != nil {
		t.Fatal(err)
	}
	args := plistArguments(t, body)
	var parsedArgs []string
	for i := 0; i < len(args); i++ {
		if args[i] == "--terminal-sock" || args[i] == "--terminal-pane" || args[i] == "--terminal-history-root" {
			parsedArgs = append(parsedArgs, args[i], args[i+1])
			i++
		}
	}
	parsed, err := config.ParseFlags(append([]string{"--probe"}, parsedArgs...))
	if err != nil || !reflect.DeepEqual(parsed.TerminalHistoryRoots, cfg.TerminalHistoryRoots) || parsed.TerminalSendMode != "" {
		t.Fatalf("launchd changed roots or enabled sending: %+v %v", parsed, err)
	}
	unit, err := GenerateSystemdUnit("/fixture/daemon", cfg, "/fixture/token")
	if err != nil {
		t.Fatal(err)
	}
	for provider, root := range cfg.TerminalHistoryRoots {
		escaped, err := EscapeSystemdArg(provider + "=" + root)
		if err != nil || !strings.Contains(unit, `"--terminal-history-root" `+escaped) {
			t.Fatalf("systemd changed root argument: %v", err)
		}
	}
	if strings.Contains(unit, "--terminal-send-mode") || strings.Contains(body, "--terminal-send-mode") {
		t.Fatal("history configuration enabled input")
	}
}

func TestServiceHistoryInvalidRootsRejectBeforeEffects(t *testing.T) {
	for _, roots := range []map[string]string{{"other": "/fixture"}, {"codex": "relative"}, {"codex": "/fixture\x00"}} {
		dir := t.TempDir()
		cfg := sampleConfig(t, dir)
		cfg.TerminalSocketPath, cfg.TerminalPanes, cfg.TerminalHistoryRoots = "/fixture/host.sock", []string{"w2:p3"}, roots
		runner := &fakeRunner{}
		for _, render := range []func(string, *config.Config, string) (string, error){GeneratePlistXML, GenerateSystemdUnit} {
			if _, err := render("/fixture/daemon", cfg, "/fixture/token"); err == nil {
				t.Fatal("invalid root reached renderer")
			}
		}
		for _, install := range []func(context.Context, *config.Config) error{
			(&DarwinManager{HomeDir: dir, Runner: runner}).Install, (&LinuxManager{HomeDir: dir, Runner: runner}).Install,
		} {
			if err := install(context.Background(), cfg); err == nil || !strings.Contains(err.Error(), "terminal-history-root") {
				t.Fatalf("invalid root not rejected before installation: %v", err)
			}
		}
		entries, err := os.ReadDir(dir)
		if err != nil || len(entries) != 0 || len(runner.calls) != 0 {
			t.Fatalf("invalid root caused service effects: %v", err)
		}
	}
}
