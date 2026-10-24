package service

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
)

const (
	DarwinPlistLabel    = "site.taoai.super-leader-daemon"
	DarwinPlistFile     = "site.taoai.super-leader-daemon.plist"
	darwinManagedMarker = "<!-- Managed by Super Leader Daemon -->"
)

type DarwinManager struct {
	Runner  Runner
	HomeDir string
	UID     int
}

func newDarwinManager(r Runner, customHome string) (*DarwinManager, error) {
	home := customHome
	if home == "" {
		var err error
		home, err = os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("resolve user home directory: %w", err)
		}
	}
	return &DarwinManager{
		Runner:  r,
		HomeDir: home,
		UID:     os.Getuid(),
	}, nil
}

func (m *DarwinManager) ResolvePlistPath() string {
	return filepath.Join(m.HomeDir, "Library", "LaunchAgents", DarwinPlistFile)
}

func (m *DarwinManager) DomainTarget() string {
	return fmt.Sprintf("gui/%d", m.UID)
}

func (m *DarwinManager) ServiceTarget() string {
	return fmt.Sprintf("gui/%d/%s", m.UID, DarwinPlistLabel)
}

// GeneratePlistXML creates valid launchd plist XML.
func GeneratePlistXML(binPath string, cfg *config.Config, tokenFilePath string) (string, error) {
	args, err := daemonServiceArgs(binPath, cfg, tokenFilePath)
	if err != nil {
		return "", err
	}

	var buf bytes.Buffer
	buf.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
	buf.WriteString(darwinManagedMarker + "\n")
	buf.WriteString("<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n")
	buf.WriteString("<plist version=\"1.0\">\n<dict>\n")
	buf.WriteString("\t<key>Label</key>\n\t<string>")
	if err := xml.EscapeText(&buf, []byte(DarwinPlistLabel)); err != nil {
		return "", err
	}
	buf.WriteString("</string>\n")
	buf.WriteString("\t<key>ProgramArguments</key>\n\t<array>\n")
	for _, arg := range args {
		buf.WriteString("\t\t<string>")
		if err := xml.EscapeText(&buf, []byte(arg)); err != nil {
			return "", err
		}
		buf.WriteString("</string>\n")
	}
	buf.WriteString("\t</array>\n")
	buf.WriteString("\t<key>RunAtLoad</key>\n\t<true/>\n")
	buf.WriteString("\t<key>KeepAlive</key>\n\t<true/>\n")
	buf.WriteString("\t<key>ProcessType</key>\n\t<string>Interactive</string>\n")
	buf.WriteString("\t<key>Umask</key><integer>63</integer>\n")
	for _, item := range []struct{ key, file string }{{"StandardOutPath", "daemon.stdout.log"}, {"StandardErrorPath", "daemon.stderr.log"}} {
		buf.WriteString("<key>" + item.key + "</key><string>")
		if err := xml.EscapeText(&buf, []byte(filepath.Join(cfg.StateDir, item.file))); err != nil {
			return "", err
		}
		buf.WriteString("</string>\n")
	}
	buf.WriteString("</dict>\n</plist>\n")
	return buf.String(), nil
}

func (m *DarwinManager) verifyExistingPlistOwnership(plistPath string) error {
	if err := VerifySafeWriteTarget(plistPath); err != nil {
		return err
	}
	info, err := os.Lstat(plistPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return errors.New("launch agent plist is a symlink; refusing operation")
	}
	if !info.Mode().IsRegular() {
		return errors.New("launch agent plist is not a regular file; refusing operation")
	}
	data, err := os.ReadFile(plistPath)
	if err != nil {
		return fmt.Errorf("read existing plist: %w", err)
	}
	managedBin, err := ResolveManagedBinaryPath(m.HomeDir)
	if err != nil {
		return err
	}
	decoder := xml.NewDecoder(bytes.NewReader(data))
	var key, label string
	var args []string
	labels, programs := 0, 0
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("invalid launch agent XML: %w", err)
		}
		start, ok := token.(xml.StartElement)
		if !ok {
			continue
		}
		switch start.Name.Local {
		case "key":
			if err := decoder.DecodeElement(&key, &start); err != nil {
				return err
			}
		case "string":
			var value string
			if err := decoder.DecodeElement(&value, &start); err != nil {
				return err
			}
			if key == "Label" {
				label = value
				labels++
			}
			key = ""
		case "array":
			var value struct {
				Strings []string `xml:"string"`
			}
			if err := decoder.DecodeElement(&value, &start); err != nil {
				return err
			}
			if key == "ProgramArguments" {
				args = value.Strings
				programs++
			}
			key = ""
		}
	}
	if !bytes.Contains(data, []byte(darwinManagedMarker)) || labels != 1 || programs != 1 || label != DarwinPlistLabel || len(args) == 0 || args[0] != managedBin {
		return fmt.Errorf("existing plist at %s does not belong to %s; refusing operation", plistPath, DarwinPlistLabel)
	}
	return nil
}

func (m *DarwinManager) Install(ctx context.Context, cfg *config.Config) error {
	if err := config.ValidateTerminalHistory(cfg.TerminalHistoryRoots, cfg.TerminalSocketPath, cfg.TerminalPanes); err != nil {
		return err
	}
	if err := config.ValidateTerminalSend(cfg.TerminalSendMode, cfg.TerminalSocketPath, cfg.TerminalPanes); err != nil {
		return err
	}
	if err := config.ValidateTerminalObservation(cfg.TerminalSocketPath, cfg.TerminalPanes); err != nil {
		return err
	}
	if err := validateTokenFileInput(cfg.StateDir, cfg.NodeToken); err != nil {
		return fmt.Errorf("write token file: %w", err)
	}
	if err := EnsureNotRoot(); err != nil {
		return err
	}
	managedBin, err := ResolveManagedBinaryPath(m.HomeDir)
	if err != nil {
		return err
	}
	tokenFile := ResolveTokenFilePath(cfg.StateDir)
	plistContent, err := GeneratePlistXML(managedBin, cfg, tokenFile)
	if err != nil {
		return err
	}
	plistPath := m.ResolvePlistPath()
	if err := m.verifyExistingPlistOwnership(plistPath); err != nil {
		return err
	}
	if _, err := os.Lstat(plistPath); err == nil {
		if err := m.Stop(ctx); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := InstallManagedBinary("", managedBin); err != nil {
		return fmt.Errorf("install managed binary: %w", err)
	}
	if _, err := WritePrivateTokenFile(cfg.StateDir, cfg.NodeToken); err != nil {
		return fmt.Errorf("write token file: %w", err)
	}

	if err := AtomicWriteFile(plistPath, []byte(plistContent), 0644); err != nil {
		return fmt.Errorf("write plist file: %w", err)
	}

	if _, err := m.Runner.Run(ctx, "launchctl", "enable", m.ServiceTarget()); err != nil {
		return fmt.Errorf("launchctl enable failed: %w", err)
	}
	if _, err := m.Runner.Run(ctx, "launchctl", "bootstrap", m.DomainTarget(), plistPath); err != nil {
		return fmt.Errorf("launchctl bootstrap failed: %w", err)
	}
	return nil
}

func (m *DarwinManager) Start(ctx context.Context) error {
	if err := EnsureNotRoot(); err != nil {
		return err
	}
	plistPath := m.ResolvePlistPath()
	if err := m.verifyExistingPlistOwnership(plistPath); err != nil {
		return err
	}
	if _, err := os.Stat(plistPath); err != nil {
		return fmt.Errorf("service not installed: plist missing at %s", plistPath)
	}

	info, err := m.Status(ctx)
	if err != nil {
		return err
	}
	if info.Running {
		return nil
	}
	if _, err := m.Runner.Run(ctx, "launchctl", "enable", m.ServiceTarget()); err != nil {
		return fmt.Errorf("launchctl enable failed: %w", err)
	}
	if info.Detail == darwinNotLoaded {
		if _, err := m.Runner.Run(ctx, "launchctl", "bootstrap", m.DomainTarget(), plistPath); err != nil {
			return fmt.Errorf("launchctl bootstrap failed: %w", err)
		}
	} else if _, err := m.Runner.Run(ctx, "launchctl", "kickstart", m.ServiceTarget()); err != nil {
		return fmt.Errorf("launchctl kickstart failed: %w", err)
	}
	return nil
}

func (m *DarwinManager) Stop(ctx context.Context) error {
	if err := EnsureNotRoot(); err != nil {
		return err
	}
	plistPath := m.ResolvePlistPath()
	if err := m.verifyExistingPlistOwnership(plistPath); err != nil {
		return err
	}
	if _, err := os.Stat(plistPath); err != nil {
		return fmt.Errorf("service not installed: plist missing at %s", plistPath)
	}

	out, err := m.Runner.Run(ctx, "launchctl", "bootout", m.ServiceTarget())
	if err != nil {
		outStr := string(out)
		if launchServiceMissing(outStr) {
			return nil
		}
		return fmt.Errorf("launchctl stop failed: %w (output: %s)", err, outStr)
	}
	return nil
}

func (m *DarwinManager) Restart(ctx context.Context) error {
	if err := m.Stop(ctx); err != nil {
		return err
	}
	return m.Start(ctx)
}

var (
	darwinStateRe = regexp.MustCompile("(?m)^[ \\t]*state[ \\t]*=[ \\t]*([a-zA-Z0-9_ -]+)")
	darwinPIDRe   = regexp.MustCompile("(?m)^[ \\t]*pid[ \\t]*=[ \\t]*([0-9]+)")
)

const darwinNotLoaded = "service installed but not loaded in launchd"

func launchServiceMissing(output string) bool {
	return strings.Contains(output, "Could not find service") || strings.Contains(output, "No such process")
}

func (m *DarwinManager) Status(ctx context.Context) (StatusInfo, error) {
	plistPath := m.ResolvePlistPath()
	if _, err := os.Lstat(plistPath); errors.Is(err, os.ErrNotExist) {
		return StatusInfo{Installed: false, Detail: "plist file not found"}, nil
	} else if err != nil {
		return StatusInfo{}, err
	}
	if err := m.verifyExistingPlistOwnership(plistPath); err != nil {
		return StatusInfo{Installed: false, Detail: err.Error()}, err
	}

	out, err := m.Runner.Run(ctx, "launchctl", "print", m.ServiceTarget())
	if err != nil {
		if !launchServiceMissing(string(out)) {
			return StatusInfo{}, fmt.Errorf("launchctl status failed: %w", err)
		}
		return StatusInfo{
			Installed: true,
			Running:   false,
			Detail:    darwinNotLoaded,
		}, nil
	}
	outStr := string(out)
	stateMatch := darwinStateRe.FindStringSubmatch(outStr)
	state := "unknown"
	if len(stateMatch) > 1 {
		state = strings.TrimSpace(stateMatch[1])
	}
	pid := 0
	pidMatch := darwinPIDRe.FindStringSubmatch(outStr)
	if len(pidMatch) > 1 {
		pid, err = strconv.Atoi(pidMatch[1])
		if err != nil {
			return StatusInfo{}, fmt.Errorf("invalid launchctl PID: %w", err)
		}
	}

	running := state == "running" && pid > 0
	return StatusInfo{
		Installed: true,
		Running:   running,
		PID:       pid,
		Detail:    fmt.Sprintf("state=%s", state),
	}, nil
}

func (m *DarwinManager) Uninstall(ctx context.Context) error {
	if err := EnsureNotRoot(); err != nil {
		return err
	}
	plistPath := m.ResolvePlistPath()
	if _, err := os.Lstat(plistPath); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	if err := m.verifyExistingPlistOwnership(plistPath); err != nil {
		return err
	}

	if err := m.Stop(ctx); err != nil {
		return err
	}
	if _, err := m.Runner.Run(ctx, "launchctl", "disable", m.ServiceTarget()); err != nil {
		return fmt.Errorf("launchctl disable failed: %w", err)
	}

	if err := os.Remove(plistPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove plist file: %w", err)
	}
	return nil
}
