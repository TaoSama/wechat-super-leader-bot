package config_test

import (
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
)

func TestTerminalSendModeExplicitAndExact(t *testing.T) {
	t.Setenv("TERMINAL_SEND_MODE", "non-atomic")
	base := []string{"--probe", "--terminal-sock", "/fixture/terminal.sock", "--terminal-pane", "w1:p1"}
	cfg, err := config.ParseFlags(base)
	if err != nil || cfg.TerminalSendMode != "" {
		t.Fatalf("implicit mode: %+v %v", cfg, err)
	}
	cfg, err = config.ParseFlags(append(base, "--terminal-send-mode=non-atomic"))
	if err != nil || cfg.TerminalSendMode != "non-atomic" {
		t.Fatal(err)
	}
	for _, flags := range [][]string{
		{"--probe", "--terminal-send-mode=non-atomic"},
		append(append([]string{}, base...), "--terminal-send-mode=atomic"),
		append(append([]string{}, base...), "--terminal-send-mode= non-atomic"),
	} {
		if _, err := config.ParseFlags(flags); err == nil {
			t.Fatal("invalid mode accepted")
		}
	}
}
