package config

import (
	"errors"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/terminal"
)

const MaxTerminalPanes = terminal.MaxPanes

// ValidateTerminalObservation is shared by flag parsing and service rendering.
// It only checks explicit selectors; it never resolves or opens a socket.
func ValidateTerminalObservation(socket string, panes []string) error {
	if socket == "" && len(panes) == 0 {
		return nil
	}
	if socket == "" || len(panes) == 0 {
		return errors.New("terminal-sock and terminal-pane must be configured together")
	}
	return terminal.ValidateSelectors(socket, panes)
}

func ValidateTerminalSend(mode, socket string, panes []string) error {
	if mode == "" {
		return nil
	}
	if mode != protocol.TerminalNonAtomicMode || socket == "" || len(panes) == 0 {
		return errors.New("terminal-send-mode must be non-atomic with explicit terminal-sock and terminal-pane")
	}
	return ValidateTerminalObservation(socket, panes)
}
