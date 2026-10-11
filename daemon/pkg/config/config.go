package config

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	DefaultNodeID           = "macair"
	DefaultControllerURL    = "ws://127.0.0.1:8790/v1/daemon"
	DefaultTokenEnv         = "NODE_TOKEN"
	DefaultHeartbeatSeconds = 15
	MaxSkillRoots           = 16
	CodexSocketRelPath      = ".codex/app-server-control/app-server-control.sock"

	ServiceActionInstall   = "install"
	ServiceActionStart     = "start"
	ServiceActionStop      = "stop"
	ServiceActionRestart   = "restart"
	ServiceActionStatus    = "status"
	ServiceActionUninstall = "uninstall"
)

type Config struct {
	NodeID             string
	ControllerURL      string
	NodeToken          string
	SocketPath         string
	DesktopSocketPath  string
	DesktopSend        bool
	TerminalSocketPath string
	TerminalPanes      []string
	TerminalSendMode   string
	CodexHome          string
	HeartbeatInterval  time.Duration
	ProbeOnly          bool
	ProbeSkills        bool
	ServiceAction      string
	SkillRoots         []string
	StateDir           string
}

func ParseFlags(args []string) (*Config, error) {
	fs := flag.NewFlagSet("super-leader-daemon", flag.ContinueOnError)

	defaultNodeID := strings.TrimSpace(os.Getenv("NODE_ID"))
	if defaultNodeID == "" {
		defaultNodeID = DefaultNodeID
	}

	defaultControllerURL := strings.TrimSpace(os.Getenv("CONTROLLER_WS_URL"))
	if defaultControllerURL == "" {
		defaultControllerURL = strings.TrimSpace(os.Getenv("CONTROLLER_URL"))
	}
	if defaultControllerURL == "" {
		defaultControllerURL = DefaultControllerURL
	}

	defaultSock := strings.TrimSpace(os.Getenv("CODEX_APP_SERVER_SOCKET"))

	nodeID := fs.String("node-id", defaultNodeID, "Node identifier (e.g. macair)")
	controllerURL := fs.String("controller-url", defaultControllerURL, "Controller WebSocket URL (e.g. ws://127.0.0.1:8790/v1/daemon)")
	tokenEnv := fs.String("token-env", DefaultTokenEnv, "Environment variable name containing node token")
	tokenFile := fs.String("token-file", "", "Path to file containing node token (overrides token-env)")
	socketPath := fs.String("sock", defaultSock, "Path to Codex app-server Unix domain socket")
	desktopSocketPath := fs.String("desktop-sock", "", "Optional existing desktop IPC socket for read-only execution-state observation")
	desktopSend := fs.Bool("desktop-send", false, "Explicitly allow sending through the existing desktop owner (requires desktop-sock)")
	terminalSocketPath := fs.String("terminal-sock", "", "Optional existing terminal-host Unix socket for read-only observation (requires terminal-pane)")
	terminalSendMode := fs.String("terminal-send-mode", "", "Explicit terminal input delivery mode: non-atomic (requires terminal-sock and terminal-pane)")
	var terminalPanes []string
	fs.Func("terminal-pane", "Explicit terminal pane wN:pN to observe read-only (repeatable, at most 16)", func(value string) error {
		terminalPanes = append(terminalPanes, value)
		return nil
	})
	codexHome := fs.String("codex-home", "", "Optional absolute Codex directory: discover session metadata from files without starting a backend")
	heartbeatSec := fs.Int("heartbeat", DefaultHeartbeatSeconds, "Heartbeat interval in seconds (must be > 0)")
	probeOnly := fs.Bool("probe", false, "Read-only probe configured session sources, output discovery and source availability as JSON, then exit")
	probeSkills := fs.Bool("probe-skills", false, "Read-only scan configured skill roots and exit; no socket or Controller connection")
	serviceAction := fs.String("service", "", "Manage user service: install|start|stop|restart|status|uninstall")
	stateDir := fs.String("state-dir", os.Getenv("DAEMON_STATE_DIR"), "Private durable command journal directory; defaults to ~/.super-leader/daemon/<node hash>")
	var skillRoots []string
	if raw := os.Getenv("SKILL_ROOTS"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &skillRoots); err != nil {
			return nil, errors.New("SKILL_ROOTS must be a JSON array of absolute directory paths")
		}
	}
	fs.Func("skill-root", "Additional permitted skill directory (repeatable); defaults to SKILL_ROOTS JSON array or none", func(value string) error {
		skillRoots = append(skillRoots, value)
		return nil
	})

	if err := fs.Parse(args); err != nil {
		return nil, err
	}

	if fs.NArg() > 0 {
		return nil, fmt.Errorf("unexpected positional arguments: %v (credentials must not be passed via positional args)", fs.Args())
	}
	action := strings.ToLower(strings.TrimSpace(*serviceAction))
	if action != "" {
		switch action {
		case ServiceActionInstall, ServiceActionStart, ServiceActionStop, ServiceActionRestart, ServiceActionStatus, ServiceActionUninstall:
		default:
			return nil, fmt.Errorf("invalid service action %q: must be install, start, stop, restart, status, or uninstall", *serviceAction)
		}
	}
	modeCount := 0
	if *probeOnly {
		modeCount++
	}
	if *probeSkills {
		modeCount++
	}
	if action != "" {
		modeCount++
	}
	if modeCount > 1 {
		return nil, errors.New("choose only one of probe, probe-skills, or service")
	}
	if len(skillRoots) > MaxSkillRoots {
		return nil, errors.New("at most 16 skill roots are supported")
	}
	for _, root := range skillRoots {
		if !filepath.IsAbs(root) || strings.ContainsAny(root, "\x00\r\n") {
			return nil, errors.New("each skill root must be an absolute directory path without control characters")
		}
	}

	if *heartbeatSec <= 0 {
		return nil, fmt.Errorf("heartbeat interval must be > 0 seconds, got %d", *heartbeatSec)
	}

	resolvedSock := strings.TrimSpace(*socketPath)
	if *desktopSocketPath != "" && (!filepath.IsAbs(*desktopSocketPath) || strings.ContainsAny(*desktopSocketPath, "\x00\r\n")) {
		return nil, errors.New("desktop-sock must be an absolute path without control characters")
	}
	if *desktopSend && *desktopSocketPath == "" {
		return nil, errors.New("desktop-send requires an explicit desktop-sock")
	}
	if err := ValidateTerminalObservation(*terminalSocketPath, terminalPanes); err != nil {
		return nil, err
	}
	if err := ValidateTerminalSend(*terminalSendMode, *terminalSocketPath, terminalPanes); err != nil {
		return nil, err
	}
	if *codexHome != "" && (!filepath.IsAbs(*codexHome) || strings.ContainsAny(*codexHome, "\x00\r\n\t")) {
		return nil, errors.New("codex-home must be an absolute directory path without control characters")
	}
	if resolvedSock == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("failed to resolve user home directory for default socket path: %w", err)
		}
		resolvedSock = filepath.Join(home, CodexSocketRelPath)
	}

	cfg := &Config{
		NodeID:             strings.TrimSpace(*nodeID),
		ControllerURL:      strings.TrimSpace(*controllerURL),
		SocketPath:         resolvedSock,
		DesktopSocketPath:  *desktopSocketPath,
		DesktopSend:        *desktopSend,
		TerminalSocketPath: *terminalSocketPath,
		TerminalPanes:      append([]string(nil), terminalPanes...),
		TerminalSendMode:   *terminalSendMode,
		CodexHome:          *codexHome,
		HeartbeatInterval:  time.Duration(*heartbeatSec) * time.Second,
		ProbeOnly:          *probeOnly,
		ProbeSkills:        *probeSkills,
		ServiceAction:      action,
		SkillRoots:         skillRoots,
	}

	if cfg.NodeID == "" {
		return nil, errors.New("node-id must not be empty")
	}
	cfg.StateDir = *stateDir
	if cfg.StateDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("resolve daemon state directory: %w", err)
		}
		digest := sha256.Sum256([]byte(cfg.NodeID))
		cfg.StateDir = filepath.Join(home, ".super-leader", "daemon", hex.EncodeToString(digest[:])[:16])
	}
	if !filepath.IsAbs(cfg.StateDir) || strings.ContainsAny(cfg.StateDir, "\x00\r\n") {
		return nil, errors.New("state-dir must be an absolute directory path without control characters")
	}

	requiresRuntimeAuth := !cfg.ProbeOnly && !cfg.ProbeSkills && (cfg.ServiceAction == "" || cfg.ServiceAction == ServiceActionInstall)
	if requiresRuntimeAuth {
		var token string
		if strings.TrimSpace(*tokenFile) != "" {
			data, err := os.ReadFile(strings.TrimSpace(*tokenFile))
			if err != nil {
				return nil, fmt.Errorf("failed to read token file: %w", err)
			}
			token = strings.TrimSpace(string(data))
		} else if strings.TrimSpace(*tokenEnv) != "" {
			token = strings.TrimSpace(os.Getenv(strings.TrimSpace(*tokenEnv)))
		}

		if token == "" {
			return nil, fmt.Errorf("node token is required: set %s or specify -token-file", *tokenEnv)
		}
		cfg.NodeToken = token

		if err := ValidateControllerURL(cfg.ControllerURL); err != nil {
			return nil, err
		}
	}

	return cfg, nil
}

// ValidateControllerURL validates scheme, loopback vs remote TLS, and rejects userinfo/query/fragment.
func ValidateControllerURL(rawURL string) error {
	if strings.TrimSpace(rawURL) == "" {
		return errors.New("controller URL must not be empty")
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("invalid controller URL: %w", err)
	}
	if u.Scheme != "ws" && u.Scheme != "wss" {
		return fmt.Errorf("controller URL must use ws:// or wss:// scheme, got %q", u.Scheme)
	}
	if u.Host == "" {
		return errors.New("controller URL must specify a host")
	}
	if u.User != nil {
		return errors.New("controller URL must not contain userinfo credentials")
	}
	if u.RawQuery != "" || u.ForceQuery {
		return errors.New("controller URL must not contain query parameters")
	}
	if u.Fragment != "" {
		return errors.New("controller URL must not contain a URL fragment")
	}
	host := strings.ToLower(u.Hostname())
	isLoopback := host == "localhost" || host == "127.0.0.1" || host == "::1"
	if !isLoopback && u.Scheme != "wss" {
		return fmt.Errorf("remote controller URL requires wss:// scheme (ws:// only permitted for loopback), got host %q", host)
	}
	return nil
}
