package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
)

const (
	LinuxUnitName      = "super-leader-daemon.service"
	linuxManagedMarker = "# Managed by Super Leader Daemon"
)

type LinuxManager struct {
	Runner  Runner
	HomeDir string
}

func newLinuxManager(r Runner, customHome string) (*LinuxManager, error) {
	home := customHome
	if home == "" {
		var err error
		home, err = os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("resolve user home directory: %w", err)
		}
	}
	return &LinuxManager{
		Runner:  r,
		HomeDir: home,
	}, nil
}

func (m *LinuxManager) ResolveUnitPath() string {
	return filepath.Join(m.HomeDir, ".config", "systemd", "user", LinuxUnitName)
}

// EscapeSystemdArg quotes and escapes a single ExecStart argument for systemd.
// It escapes backslash, double quote, $ (as $$), and % (as %%).
func EscapeSystemdArg(arg string) (string, error) {
	if strings.ContainsAny(arg, "\x00\r\n") {
		return "", errors.New("systemd argument must not contain control characters")
	}
	var sb strings.Builder
	sb.WriteByte('"')
	for i := 0; i < len(arg); i++ {
		c := arg[i]
		switch c {
		case '\\':
			sb.WriteString("\\\\")
		case '"':
			sb.WriteString("\\\"")
		case '$':
			sb.WriteString("$$")
		case '%':
			sb.WriteString("%%")
		default:
			sb.WriteByte(c)
		}
	}
	sb.WriteByte('"')
	return sb.String(), nil
}

// GenerateSystemdUnit creates the systemd user service unit content.
func GenerateSystemdUnit(binPath string, cfg *config.Config, tokenFilePath string) (string, error) {
	if err := config.ValidateTerminalHistory(cfg.TerminalHistoryRoots, cfg.TerminalSocketPath, cfg.TerminalPanes); err != nil {
		return "", err
	}
	if err := config.ValidateTerminalObservation(cfg.TerminalSocketPath, cfg.TerminalPanes); err != nil {
		return "", err
	}
	if binPath == "" {
		return "", errors.New("binary path must not be empty")
	}
	if cfg.DesktopSend && cfg.DesktopSocketPath == "" {
		return "", errors.New("desktop-send requires an explicit desktop-sock")
	}
	if err := config.ValidateTerminalSend(cfg.TerminalSendMode, cfg.TerminalSocketPath, cfg.TerminalPanes); err != nil {
		return "", err
	}
	rawArgs := []string{
		binPath,
		"--node-id", cfg.NodeID,
		"--controller-url", cfg.ControllerURL,
		"--token-file", tokenFilePath,
		"--sock", cfg.SocketPath,
		"--state-dir", cfg.StateDir,
		"--heartbeat", strconv.Itoa(int(cfg.HeartbeatInterval.Seconds())),
	}
	if cfg.DesktopSocketPath != "" {
		rawArgs = append(rawArgs, "--desktop-sock", cfg.DesktopSocketPath)
	}
	if cfg.DesktopSend {
		rawArgs = append(rawArgs, "--desktop-send")
	}
	if cfg.CodexHome != "" {
		rawArgs = append(rawArgs, "--codex-home", cfg.CodexHome)
	}
	if cfg.TerminalSocketPath != "" {
		rawArgs = append(rawArgs, "--terminal-sock", cfg.TerminalSocketPath)
		for _, pane := range cfg.TerminalPanes {
			rawArgs = append(rawArgs, "--terminal-pane", pane)
		}
	}
	if cfg.TerminalSendMode != "" {
		rawArgs = append(rawArgs, "--terminal-send-mode", cfg.TerminalSendMode)
	}
	rawArgs = append(rawArgs, config.TerminalHistoryArgs(cfg.TerminalHistoryRoots)...)
	for _, root := range cfg.SkillRoots {
		rawArgs = append(rawArgs, "--skill-root", root)
	}

	escapedArgs := make([]string, 0, len(rawArgs))
	for _, arg := range rawArgs {
		esc, err := EscapeSystemdArg(arg)
		if err != nil {
			return "", err
		}
		escapedArgs = append(escapedArgs, esc)
	}

	var buf bytes.Buffer
	buf.WriteString(linuxManagedMarker + "\n")
	buf.WriteString("[Unit]\n")
	buf.WriteString("Description=Super Leader Daemon\n")
	buf.WriteString("After=network-online.target\n")
	buf.WriteString("Wants=network-online.target\n\n")
	buf.WriteString("[Service]\n")
	buf.WriteString("Type=simple\n")
	buf.WriteString("ExecStart=" + strings.Join(escapedArgs, " ") + "\n")
	buf.WriteString("Restart=on-failure\n")
	buf.WriteString("RestartSec=5\n")
	buf.WriteString("UMask=0077\n\n")
	buf.WriteString("[Install]\n")
	buf.WriteString("WantedBy=default.target\n")
	return buf.String(), nil
}

func (m *LinuxManager) verifyExistingUnitOwnership(unitPath string) error {
	if err := VerifySafeWriteTarget(unitPath); err != nil {
		return err
	}
	info, err := os.Lstat(unitPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return errors.New("systemd unit file is a symlink; refusing operation")
	}
	if !info.Mode().IsRegular() {
		return errors.New("systemd unit file is not a regular file; refusing operation")
	}
	data, err := os.ReadFile(unitPath)
	if err != nil {
		return fmt.Errorf("read existing systemd unit: %w", err)
	}
	managedBin, err := ResolveManagedBinaryPath(m.HomeDir)
	if err != nil {
		return err
	}
	escBin, err := EscapeSystemdArg(managedBin)
	if err != nil {
		return err
	}
	content := string(data)
	hasMarker := false
	execStarts := 0
	validExec := false
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == linuxManagedMarker {
			hasMarker = true
		}
		if strings.HasPrefix(trimmed, "ExecStart=") {
			execStarts++
			val := strings.TrimPrefix(trimmed, "ExecStart=")
			if val == escBin || strings.HasPrefix(val, escBin+" ") || val == managedBin || strings.HasPrefix(val, managedBin+" ") {
				validExec = true
			}
		}
	}
	if !hasMarker || execStarts != 1 || !validExec {
		return fmt.Errorf("existing systemd unit at %s does not belong to %s; refusing operation", unitPath, LinuxUnitName)
	}
	return nil
}

func (m *LinuxManager) Install(ctx context.Context, cfg *config.Config) error {
	if err := config.ValidateTerminalHistory(cfg.TerminalHistoryRoots, cfg.TerminalSocketPath, cfg.TerminalPanes); err != nil {
		return err
	}
	if err := config.ValidateTerminalSend(cfg.TerminalSendMode, cfg.TerminalSocketPath, cfg.TerminalPanes); err != nil {
		return err
	}
	if err := config.ValidateTerminalObservation(cfg.TerminalSocketPath, cfg.TerminalPanes); err != nil {
		return err
	}
	if err := EnsureNotRoot(); err != nil {
		return err
	}
	managedBin, err := ResolveManagedBinaryPath(m.HomeDir)
	if err != nil {
		return err
	}
	unitPath := m.ResolveUnitPath()
	if err := m.verifyExistingUnitOwnership(unitPath); err != nil {
		return err
	}
	preExisting := false
	if _, err := os.Lstat(unitPath); err == nil {
		preExisting = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}

	if err := InstallManagedBinary("", managedBin); err != nil {
		return fmt.Errorf("install managed binary: %w", err)
	}
	tokenFile, err := WritePrivateTokenFile(cfg.StateDir, cfg.NodeToken)
	if err != nil {
		return fmt.Errorf("write token file: %w", err)
	}
	unitContent, err := GenerateSystemdUnit(managedBin, cfg, tokenFile)
	if err != nil {
		return err
	}
	if err := AtomicWriteFile(unitPath, []byte(unitContent), 0644); err != nil {
		return fmt.Errorf("write systemd unit: %w", err)
	}

	if out, err := m.Runner.Run(ctx, "systemctl", "--user", "daemon-reload"); err != nil {
		return fmt.Errorf("systemctl daemon-reload failed: %w (output: %s)", err, strings.TrimSpace(string(out)))
	}
	if out, err := m.Runner.Run(ctx, "systemctl", "--user", "enable", "--now", LinuxUnitName); err != nil {
		return fmt.Errorf("systemctl enable --now failed: %w (output: %s)", err, strings.TrimSpace(string(out)))
	}
	if preExisting {
		if out, err := m.Runner.Run(ctx, "systemctl", "--user", "restart", LinuxUnitName); err != nil {
			return fmt.Errorf("systemctl restart failed: %w (output: %s)", err, strings.TrimSpace(string(out)))
		}
	}
	return nil
}

func (m *LinuxManager) Start(ctx context.Context) error {
	if err := EnsureNotRoot(); err != nil {
		return err
	}
	unitPath := m.ResolveUnitPath()
	if err := m.verifyExistingUnitOwnership(unitPath); err != nil {
		return err
	}
	if _, err := os.Stat(unitPath); err != nil {
		return fmt.Errorf("service not installed: unit missing at %s", unitPath)
	}
	if out, err := m.Runner.Run(ctx, "systemctl", "--user", "start", LinuxUnitName); err != nil {
		return fmt.Errorf("systemctl start failed: %w (output: %s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (m *LinuxManager) Stop(ctx context.Context) error {
	if err := EnsureNotRoot(); err != nil {
		return err
	}
	unitPath := m.ResolveUnitPath()
	if err := m.verifyExistingUnitOwnership(unitPath); err != nil {
		return err
	}
	if _, err := os.Stat(unitPath); err != nil {
		return fmt.Errorf("service not installed: unit missing at %s", unitPath)
	}
	if out, err := m.Runner.Run(ctx, "systemctl", "--user", "stop", LinuxUnitName); err != nil {
		return fmt.Errorf("systemctl stop failed: %w (output: %s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (m *LinuxManager) Restart(ctx context.Context) error {
	if err := EnsureNotRoot(); err != nil {
		return err
	}
	unitPath := m.ResolveUnitPath()
	if err := m.verifyExistingUnitOwnership(unitPath); err != nil {
		return err
	}
	if _, err := os.Stat(unitPath); err != nil {
		return fmt.Errorf("service not installed: unit missing at %s", unitPath)
	}
	if out, err := m.Runner.Run(ctx, "systemctl", "--user", "restart", LinuxUnitName); err != nil {
		return fmt.Errorf("systemctl restart failed: %w (output: %s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (m *LinuxManager) Status(ctx context.Context) (StatusInfo, error) {
	unitPath := m.ResolveUnitPath()
	if _, err := os.Lstat(unitPath); errors.Is(err, os.ErrNotExist) {
		return StatusInfo{Installed: false, Detail: "unit file not found"}, nil
	} else if err != nil {
		return StatusInfo{}, err
	}
	if err := m.verifyExistingUnitOwnership(unitPath); err != nil {
		return StatusInfo{Installed: false, Detail: err.Error()}, err
	}

	out, err := m.Runner.Run(ctx, "systemctl", "--user", "show", "--property=ActiveState,SubState,MainPID", LinuxUnitName)
	if err != nil {
		return StatusInfo{}, fmt.Errorf("systemctl show failed: %w (output: %s)", err, strings.TrimSpace(string(out)))
	}
	activeState := "unknown"
	subState := "unknown"
	pid := 0
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "ActiveState=") {
			activeState = strings.TrimPrefix(line, "ActiveState=")
		} else if strings.HasPrefix(line, "SubState=") {
			subState = strings.TrimPrefix(line, "SubState=")
		} else if strings.HasPrefix(line, "MainPID=") {
			val := strings.TrimPrefix(line, "MainPID=")
			parsed, convErr := strconv.Atoi(val)
			if convErr != nil {
				return StatusInfo{}, fmt.Errorf("invalid systemd MainPID %q: %w", val, convErr)
			}
			pid = parsed
		}
	}
	running := activeState == "active" && subState == "running" && pid > 0
	return StatusInfo{
		Installed: true,
		Running:   running,
		PID:       pid,
		Detail:    fmt.Sprintf("active=%s sub=%s", activeState, subState),
	}, nil
}

func (m *LinuxManager) Uninstall(ctx context.Context) error {
	if err := EnsureNotRoot(); err != nil {
		return err
	}
	unitPath := m.ResolveUnitPath()
	if _, err := os.Lstat(unitPath); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	if err := m.verifyExistingUnitOwnership(unitPath); err != nil {
		return err
	}

	if out, err := m.Runner.Run(ctx, "systemctl", "--user", "disable", "--now", LinuxUnitName); err != nil {
		return fmt.Errorf("systemctl disable --now failed: %w (output: %s)", err, strings.TrimSpace(string(out)))
	}
	if err := os.Remove(unitPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove unit file: %w", err)
	}
	if out, err := m.Runner.Run(ctx, "systemctl", "--user", "daemon-reload"); err != nil {
		return fmt.Errorf("systemctl daemon-reload failed: %w (output: %s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}
