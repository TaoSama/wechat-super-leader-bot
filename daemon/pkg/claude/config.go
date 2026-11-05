// Package claude adapts existing Claude Code CLI sessions. It discovers
// transcripts, reads bounded public text and runs exactly one headless resumed
// turn per send. It never creates, forks or attaches to a session.
package claude

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	ProviderClaudeCode = "claude-code"

	// DefaultPermissionMode denies every tool call that would otherwise prompt,
	// so an unattended run never waits for input and never widens permissions.
	DefaultPermissionMode = "dontAsk"
	// DefaultRunTimeout bounds one resumed turn, including its own tool calls.
	DefaultRunTimeout = time.Hour
	// DefaultActivityWindow treats a recently written transcript as in use by
	// another Claude Code process; resuming it would interleave two writers.
	DefaultActivityWindow = 2 * time.Minute
	// DefaultLiveCheckTimeout bounds one `claude agents --json` query.
	DefaultLiveCheckTimeout = 10 * time.Second
	// DefaultInterruptGrace is the delay between SIGINT and SIGKILL.
	DefaultInterruptGrace = 10 * time.Second

	projectsDirName = "projects"
	defaultHomeDir  = ".claude"
	maxPathBytes    = 4096
)

// PermissionModes lists the accepted --permission-mode values of the Claude CLI.
var PermissionModes = []string{"acceptEdits", "auto", "dontAsk", "manual", "plan", "bypassPermissions"}

type Config struct {
	ProjectsRoot   string
	ClaudePath     string
	PermissionMode string
	RunTimeout     time.Duration
	ActivityWindow time.Duration
	LiveCheck      time.Duration
	InterruptGrace time.Duration
}

func cleanAbsolute(path string) bool {
	return filepath.IsAbs(path) && filepath.Clean(path) == path && path != string(filepath.Separator) &&
		len(path) <= maxPathBytes && utf8.ValidString(path) && !strings.ContainsRune(path, utf8.RuneError) &&
		strings.IndexFunc(path, unicode.IsControl) < 0
}

// ValidPermissionMode accepts only modes the CLI documents.
func ValidPermissionMode(mode string) bool {
	for _, candidate := range PermissionModes {
		if mode == candidate {
			return true
		}
	}
	return false
}

// Validate checks explicit configuration only. A projects root must be the
// "projects" directory of a Claude config directory, so a resume finds the
// same transcript that discovery reported.
func (c Config) Validate() error {
	if !cleanAbsolute(c.ProjectsRoot) || filepath.Base(c.ProjectsRoot) != projectsDirName {
		return errors.New("claude-projects-root must be a clean absolute <claude config dir>/projects directory")
	}
	if !cleanAbsolute(c.ClaudePath) {
		return errors.New("claude-path must be a clean absolute executable path")
	}
	if !ValidPermissionMode(c.PermissionMode) {
		return errors.New("claude-permission-mode must be one of " + strings.Join(PermissionModes, ", "))
	}
	if c.RunTimeout <= 0 || c.ActivityWindow <= 0 || c.LiveCheck <= 0 || c.InterruptGrace <= 0 {
		return errors.New("claude timeouts must be positive")
	}
	return nil
}

// WithDefaults fills unset durations and the permission mode.
func (c Config) WithDefaults() Config {
	if c.PermissionMode == "" {
		c.PermissionMode = DefaultPermissionMode
	}
	if c.RunTimeout == 0 {
		c.RunTimeout = DefaultRunTimeout
	}
	if c.ActivityWindow == 0 {
		c.ActivityWindow = DefaultActivityWindow
	}
	if c.LiveCheck == 0 {
		c.LiveCheck = DefaultLiveCheckTimeout
	}
	if c.InterruptGrace == 0 {
		c.InterruptGrace = DefaultInterruptGrace
	}
	return c
}

// configDirOverride returns the CLAUDE_CONFIG_DIR to pass to the CLI, or ""
// when the projects root is the default ~/.claude/projects. Leaving the default
// unset keeps the CLI's normal credential lookup unchanged.
func (c Config) configDirOverride() (string, error) {
	configDir := filepath.Dir(c.ProjectsRoot)
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if configDir == filepath.Join(home, defaultHomeDir) {
		return "", nil
	}
	return configDir, nil
}
