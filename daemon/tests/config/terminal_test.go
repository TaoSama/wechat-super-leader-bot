package config_test

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/terminal"
)

func TestTerminalFlagsAreExplicitPairedAndBounded(t *testing.T) {
	cfg, err := config.ParseFlags([]string{"--probe", "--token-file", "/missing-token-must-not-read"})
	if err != nil || cfg.TerminalSocketPath != "" || len(cfg.TerminalPanes) != 0 || cfg.NodeToken != "" {
		t.Fatalf("terminal default or probe auth changed: %+v %v", cfg, err)
	}
	args := []string{"--probe", "--terminal-sock", "/fixture/host socket.sock", "--terminal-pane", "w0:p0", "--terminal-pane", "w2:p3"}
	cfg, err = config.ParseFlags(args)
	if err != nil || cfg.TerminalSocketPath != args[2] || !reflect.DeepEqual(cfg.TerminalPanes, []string{"w0:p0", "w2:p3"}) {
		t.Fatalf("explicit terminal selectors changed: %+v %v", cfg, err)
	}
	invalid := [][]string{
		{"--terminal-sock", "/fixture/host.sock"}, {"--terminal-pane", "w1:p1"},
		{"--terminal-sock", "relative", "--terminal-pane", "w1:p1"},
		{"--terminal-sock", "/fixture/host\n.sock", "--terminal-pane", "w1:p1"},
		{"--terminal-sock", "/fixture/host\x1b.sock", "--terminal-pane", "w1:p1"},
		{"--terminal-sock", "/fixture/host\x7f.sock", "--terminal-pane", "w1:p1"},
		{"--terminal-sock", "/fixture/host.sock", "--terminal-pane", ""},
		{"--terminal-sock", "/fixture/host.sock", "--terminal-pane", "focused"},
		{"--terminal-sock", "/fixture/host.sock", "--terminal-pane", " w1:p1"},
		{"--terminal-sock", "/fixture/host.sock", "--terminal-pane", "w1:p1", "--terminal-pane", "w1:p1"},
	}
	tooMany := []string{"--terminal-sock", "/fixture/host.sock"}
	for i := 0; i <= config.MaxTerminalPanes; i++ {
		tooMany = append(tooMany, "--terminal-pane", fmt.Sprintf("w1:p%d", i))
	}
	invalid = append(invalid, tooMany)
	for _, socket := range []string{
		"/fixture/invalid-" + string([]byte{0xff}), "/fixture/replacement-\ufffd",
		" /fixture/leading.sock", "/fixture/trailing.sock ", "/" + strings.Repeat("x", terminal.MaxIdentityBytes),
	} {
		invalid = append(invalid, []string{"--terminal-sock", socket, "--terminal-pane", "w1:p1"})
	}
	invalid = append(invalid, []string{"--terminal-sock", "/fixture/host.sock", "--terminal-pane", "w" + strings.Repeat("1", terminal.MaxIdentityBytes) + ":p1"})
	for _, flags := range invalid {
		if _, err := config.ParseFlags(append([]string{"--probe"}, flags...)); err == nil {
			t.Fatalf("accepted invalid selectors: %v", flags)
		}
	}
}
