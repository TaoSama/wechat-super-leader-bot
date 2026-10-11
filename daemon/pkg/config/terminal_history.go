package config

import (
	"errors"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"
)

const maxTranscriptRootBytes = 4096

var transcriptProviders = [...]string{"codex", "claude", "grok"}

// ValidateTerminalHistory only checks explicit configuration. It never infers a
// record directory from a home, environment variable or discovery-only setting.
func ValidateTerminalHistory(roots map[string]string, socket string, panes []string) error {
	if len(roots) == 0 {
		return nil
	}
	if socket == "" || len(panes) == 0 {
		return errors.New("terminal-history-root requires explicit terminal-sock and terminal-pane")
	}
	if err := ValidateTerminalObservation(socket, panes); err != nil {
		return err
	}
	for provider, root := range roots {
		if provider != "codex" && provider != "claude" && provider != "grok" {
			return errors.New("terminal-history-root provider must be codex, claude or grok")
		}
		if !filepath.IsAbs(root) || filepath.Clean(root) != root || root == string(filepath.Separator) ||
			len(root) > maxTranscriptRootBytes || !utf8.ValidString(root) || strings.TrimSpace(root) != root ||
			strings.ContainsRune(root, '\ufffd') || strings.IndexFunc(root, unicode.IsControl) >= 0 {
			return errors.New("terminal-history-root must name a clean absolute record directory without control characters")
		}
	}
	return nil
}

// TerminalHistoryArgs gives service renderers the same deterministic flag order.
func TerminalHistoryArgs(roots map[string]string) []string {
	var args []string
	for _, provider := range transcriptProviders {
		if root, ok := roots[provider]; ok {
			args = append(args, "--terminal-history-root", provider+"="+root)
		}
	}
	return args
}
