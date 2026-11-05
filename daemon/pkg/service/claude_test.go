package service

import (
	"strings"
	"testing"
)

// Reinstalling rebuilds arguments from the current flags only, so the Claude
// adapter must round-trip all three of its flags when enabled and none otherwise.
func TestServiceRendersClaudeAdapterOnlyWhenEnabled(t *testing.T) {
	flags := []string{"--claude-projects-root", "--claude-path", "--claude-permission-mode"}
	for _, enabled := range []bool{false, true} {
		cfg := sampleConfig(t, t.TempDir())
		if enabled {
			cfg.ClaudeProjectsRoot = "/Users/fixture/.claude/projects"
			cfg.ClaudePath = "/Users/fixture/.local/bin/claude"
			cfg.ClaudePermissionMode = "dontAsk"
		}
		for _, render := range []struct {
			name string
			call func() (string, error)
		}{
			{"launchd", func() (string, error) { return GeneratePlistXML("/fixture/daemon", cfg, "/fixture/token") }},
			{"systemd", func() (string, error) { return GenerateSystemdUnit("/fixture/daemon", cfg, "/fixture/token") }},
		} {
			data, err := render.call()
			if err != nil {
				t.Fatalf("%s: %v", render.name, err)
			}
			for _, flag := range flags {
				if strings.Contains(data, flag) != enabled {
					t.Fatalf("%s rendered %s with enabled=%t: %s", render.name, flag, enabled, data)
				}
			}
			if enabled && (!strings.Contains(data, cfg.ClaudePath) || !strings.Contains(data, cfg.ClaudeProjectsRoot)) {
				t.Fatalf("%s dropped explicit Claude paths: %s", render.name, data)
			}
		}
	}
}
