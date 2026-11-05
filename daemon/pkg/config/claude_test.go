package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/claude"
)

func TestClaudeAdapterIsOptIn(t *testing.T) {
	if _, enabled := (&Config{}).ClaudeAdapterConfig(); enabled {
		t.Fatal("adapter enabled without --claude-projects-root")
	}
	if _, err := resolveClaude("", "/usr/bin/claude", ""); err == nil {
		t.Fatal("claude-path accepted without claude-projects-root")
	}
	if _, err := resolveClaude("", "", "acceptEdits"); err == nil {
		t.Fatal("claude-permission-mode accepted without claude-projects-root")
	}
}

func TestClaudeAdapterDefaultsToNonPromptingMode(t *testing.T) {
	root := filepath.Join(t.TempDir(), "projects")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	settings, err := resolveClaude(root, "/opt/claude/bin/claude", "")
	if err != nil {
		t.Fatal(err)
	}
	if settings.PermissionMode != claude.DefaultPermissionMode || settings.PermissionMode == "bypassPermissions" {
		t.Fatalf("permission mode = %q", settings.PermissionMode)
	}
	cfg := &Config{ClaudeProjectsRoot: settings.ProjectsRoot, ClaudePath: settings.ClaudePath, ClaudePermissionMode: settings.PermissionMode}
	if got, enabled := cfg.ClaudeAdapterConfig(); !enabled || got.ProjectsRoot != root {
		t.Fatalf("adapter config = %+v enabled=%v", got, enabled)
	}
	if _, err := resolveClaude(root, "/opt/claude/bin/claude", "yolo"); err == nil {
		t.Fatal("unknown permission mode accepted")
	}
}
