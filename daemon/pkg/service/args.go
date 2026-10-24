package service

import (
	"errors"
	"strconv"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
)

// daemonServiceArgs validates and builds the arguments before platform escaping.
func daemonServiceArgs(binPath string, cfg *config.Config, tokenFilePath string) ([]string, error) {
	if err := config.ValidateTerminalHistory(cfg.TerminalHistoryRoots, cfg.TerminalSocketPath, cfg.TerminalPanes); err != nil {
		return nil, err
	}
	if err := config.ValidateTerminalObservation(cfg.TerminalSocketPath, cfg.TerminalPanes); err != nil {
		return nil, err
	}
	if binPath == "" {
		return nil, errors.New("binary path must not be empty")
	}
	if cfg.DesktopSend && cfg.DesktopSocketPath == "" {
		return nil, errors.New("desktop-send requires an explicit desktop-sock")
	}
	if err := config.ValidateTerminalSend(cfg.TerminalSendMode, cfg.TerminalSocketPath, cfg.TerminalPanes); err != nil {
		return nil, err
	}
	args := []string{
		binPath,
		"--node-id", cfg.NodeID,
		"--controller-url", cfg.ControllerURL,
		"--token-file", tokenFilePath,
		"--sock", cfg.SocketPath,
		"--state-dir", cfg.StateDir,
		"--heartbeat", strconv.Itoa(int(cfg.HeartbeatInterval.Seconds())),
	}
	if cfg.DesktopSocketPath != "" {
		args = append(args, "--desktop-sock", cfg.DesktopSocketPath)
	}
	if cfg.DesktopSend {
		args = append(args, "--desktop-send")
	}
	if cfg.CodexHome != "" {
		args = append(args, "--codex-home", cfg.CodexHome)
	}
	if cfg.TerminalSocketPath != "" {
		args = append(args, "--terminal-sock", cfg.TerminalSocketPath)
		for _, pane := range cfg.TerminalPanes {
			args = append(args, "--terminal-pane", pane)
		}
	}
	if cfg.TerminalSendMode != "" {
		args = append(args, "--terminal-send-mode", cfg.TerminalSendMode)
	}
	args = append(args, config.TerminalHistoryArgs(cfg.TerminalHistoryRoots)...)
	for _, root := range cfg.SkillRoots {
		args = append(args, "--skill-root", root)
	}
	return args, nil
}
