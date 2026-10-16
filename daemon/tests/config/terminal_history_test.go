package config_test

import (
	"reflect"
	"strings"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
)

func TestTerminalHistoryRootsAreExplicitAndDoNotBroadenDiscovery(t *testing.T) {
	base := []string{"--probe", "--terminal-sock", "/fixture/host.sock", "--terminal-pane", "w2:p3"}
	cfg, err := config.ParseFlags(append(append([]string{}, base...), "--codex-home", "/fixture/codex"))
	if err != nil || len(cfg.TerminalHistoryRoots) != 0 {
		t.Fatalf("discovery-only root enabled transcript access: %+v %v", cfg, err)
	}
	want := map[string]string{"codex": "/fixture/codex sessions", "claude": "/fixture/projects", "grok": "/fixture/grok=sessions"}
	args := append(append([]string{}, base...), config.TerminalHistoryArgs(want)...)
	cfg, err = config.ParseFlags(args)
	if err != nil || !reflect.DeepEqual(cfg.TerminalHistoryRoots, want) || cfg.TerminalSendMode != "" {
		t.Fatalf("explicit roots changed or enabled input: %+v %v", cfg, err)
	}
	for _, flags := range [][]string{
		{"--terminal-history-root", "codex"}, {"--terminal-history-root", "codex="},
		{"--terminal-history-root", "unknown=/fixture"}, {"--terminal-history-root", "codex=relative"},
		{"--terminal-history-root", "codex=/"}, {"--terminal-history-root", "codex=/fixture/../outside"},
		{"--terminal-history-root", "codex=/fixture/"}, {"--terminal-history-root", "codex=/fixture\nsecret"},
		{"--terminal-history-root", "codex=/fixture\x1bsecret"}, {"--terminal-history-root", "codex=/fixture\ufffd"},
		{"--terminal-history-root", "codex=/fixture "}, {"--terminal-history-root", "codex=/" + strings.Repeat("a", 4096)},
		{"--terminal-history-root", "codex=/fixture", "--terminal-history-root", "codex=/fixture"},
	} {
		if _, err := config.ParseFlags(append(append([]string{}, base...), flags...)); err == nil {
			t.Fatalf("accepted invalid history roots: %q", flags)
		}
	}
	if _, err := config.ParseFlags([]string{"--probe", "--terminal-history-root", "codex=/fixture"}); err == nil {
		t.Fatal("history roots accepted without explicit terminal selectors")
	}
}
