package service

import (
	"context"
	"encoding/xml"
	"os"
	"strings"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/terminal"
)

func plistArguments(t *testing.T, body string) []string {
	t.Helper()
	decoder := xml.NewDecoder(strings.NewReader(body))
	for {
		token, err := decoder.Token()
		if err != nil {
			t.Fatalf("ProgramArguments missing or malformed: %v", err)
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "array" {
			continue
		}
		var array struct {
			Values []string `xml:"string"`
		}
		if err := decoder.DecodeElement(&array, &start); err != nil {
			t.Fatal(err)
		}
		return array.Values
	}
}

func TestServicesRejectBadTerminalBeforeSideEffects(t *testing.T) {
	for _, invalid := range []struct {
		socket string
		panes  []string
	}{
		{"/fixture/socket", []string{"focus"}},
		{"/fixture/invalid-" + string([]byte{0xff}), []string{"w1:p1"}},
		{"/fixture/replacement-\ufffd", []string{"w1:p1"}},
		{"/fixture/escape-\x1b", []string{"w1:p1"}},
		{"/fixture/trailing ", []string{"w1:p1"}},
		{" /fixture/leading", []string{"w1:p1"}},
		{"/" + strings.Repeat("x", terminal.MaxIdentityBytes), []string{"w1:p1"}},
		{"/fixture/socket", []string{"w" + strings.Repeat("1", terminal.MaxIdentityBytes) + ":p1"}},
	} {
		dir := t.TempDir()
		cfg := sampleConfig(t, dir)
		cfg.TerminalSocketPath, cfg.TerminalPanes = invalid.socket, invalid.panes
		runner := &fakeRunner{}
		for _, render := range []func(string, *config.Config, string) (string, error){GeneratePlistXML, GenerateSystemdUnit} {
			if _, err := render("/fixture/daemon", cfg, "/fixture/token"); err == nil {
				t.Fatal("service renderer accepted invalid selectors")
			}
		}
		for _, install := range []func(context.Context, *config.Config) error{
			(&DarwinManager{HomeDir: dir, Runner: runner}).Install,
			(&LinuxManager{HomeDir: dir, Runner: runner}).Install,
		} {
			if err := install(context.Background(), cfg); err == nil || !strings.Contains(err.Error(), "terminal") {
				t.Fatalf("invalid selectors not rejected first: %v", err)
			}
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 0 || len(runner.calls) != 0 {
			t.Fatal("invalid configuration caused service side effects")
		}
	}
}

func TestServicesPreserveExplicitTerminalSelectors(t *testing.T) {
	cfg := sampleConfig(t, t.TempDir())
	cfg.TerminalSocketPath = "/fixture/space & $host%/terminal.sock"
	cfg.TerminalPanes = []string{"w0:p0", "w22:p3"}
	plist, err := GeneratePlistXML("/fixture/daemon", cfg, "/fixture/token")
	if err != nil {
		t.Fatal(err)
	}
	args := plistArguments(t, plist)
	var terminalArgs []string
	for i := 0; i < len(args); i++ {
		if args[i] == "--terminal-sock" || args[i] == "--terminal-pane" {
			terminalArgs = append(terminalArgs, args[i], args[i+1])
			i++
		}
	}
	parsed, err := config.ParseFlags(append([]string{"--probe"}, terminalArgs...))
	if err != nil || parsed.TerminalSocketPath != cfg.TerminalSocketPath || strings.Join(parsed.TerminalPanes, ",") != strings.Join(cfg.TerminalPanes, ",") {
		t.Fatalf("launchd changed selectors: %+v %v", parsed, err)
	}
	unit, err := GenerateSystemdUnit("/fixture/daemon", cfg, "/fixture/token")
	if err != nil {
		t.Fatal(err)
	}
	escapedSocket, err := EscapeSystemdArg(cfg.TerminalSocketPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(unit, `"--terminal-sock" `+escapedSocket+` "--terminal-pane" "w0:p0" "--terminal-pane" "w22:p3"`) {
		t.Fatal("systemd changed terminal argument ordering or escaping")
	}
	cfg.TerminalSocketPath, cfg.TerminalPanes = "", nil
	for _, render := range []func(string, *config.Config, string) (string, error){GeneratePlistXML, GenerateSystemdUnit} {
		body, err := render("/fixture/daemon", cfg, "/fixture/token")
		if err != nil || strings.Contains(body, "--terminal-") {
			t.Fatal("service enabled implicit terminal observation")
		}
	}
}

func TestServicesValidateConstructedTerminalConfig(t *testing.T) {
	for _, setup := range []struct {
		socket string
		panes  []string
	}{
		{"/fixture/host.sock", nil}, {"", []string{"w1:p1"}}, {"relative", []string{"w1:p1"}},
		{"/fixture/host.sock", []string{"focus"}}, {"/fixture/host.sock", []string{"w1:p1", "w1:p1"}},
	} {
		cfg := sampleConfig(t, t.TempDir())
		cfg.TerminalSocketPath, cfg.TerminalPanes = setup.socket, setup.panes
		for _, render := range []func(string, *config.Config, string) (string, error){GeneratePlistXML, GenerateSystemdUnit} {
			if _, err := render("/fixture/daemon", cfg, "/fixture/token"); err == nil {
				t.Fatal("service accepted invalid constructed terminal config")
			}
		}
	}
}
