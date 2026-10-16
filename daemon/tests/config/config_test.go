package config_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
)

func TestDesktopSocketIsExplicitAndReadOnlyProbeNeedsNoToken(t *testing.T) {
	cfg, err := config.ParseFlags([]string{"--probe"})
	if err != nil || cfg.DesktopSocketPath != "" {
		t.Fatalf("default desktop observer enabled: %+v %v", cfg, err)
	}
	for _, path := range []string{"relative.sock", "/bad\npath", "/bad\x00path"} {
		if _, err := config.ParseFlags([]string{"--probe", "--desktop-sock", path}); err == nil {
			t.Fatalf("accepted invalid desktop socket %q", path)
		}
	}
	cfg, err = config.ParseFlags([]string{"--probe", "--desktop-sock", "/tmp/existing desktop.sock"})
	if err != nil || cfg.DesktopSocketPath != "/tmp/existing desktop.sock" {
		t.Fatalf("desktop socket lost: %+v %v", cfg, err)
	}
}

func TestDesktopSendIsExplicitAndRequiresSocket(t *testing.T) {
	for _, args := range [][]string{{"--probe"}, {"--probe", "--desktop-sock", "/fixture/ipc.sock"}, {"--probe", "--desktop-sock", "/fixture/ipc.sock", "--desktop-send=false"}} {
		cfg, err := config.ParseFlags(args)
		if err != nil || cfg.DesktopSend {
			t.Fatalf("read-only flags granted sending: %+v %v", cfg, err)
		}
	}
	if _, err := config.ParseFlags([]string{"--probe", "--desktop-send"}); err == nil {
		t.Fatal("desktop-send accepted without desktop-sock")
	}
	cfg, err := config.ParseFlags([]string{"--probe", "--desktop-sock", "/fixture/ipc.sock", "--desktop-send"})
	if err != nil || !cfg.DesktopSend || cfg.DesktopSocketPath != "/fixture/ipc.sock" {
		t.Fatalf("explicit sending option lost: %+v %v", cfg, err)
	}
}

func TestCodexHomeIsExplicitAndDoesNotCreateFiles(t *testing.T) {
	t.Setenv("CODEX_HOME", "/implicit-must-not-enable-discovery")
	cfg, err := config.ParseFlags([]string{"--probe"})
	if err != nil || cfg.CodexHome != "" {
		t.Fatalf("implicit catalog enabled: %+v %v", cfg, err)
	}
	for _, path := range []string{"relative", "/bad\npath", "/bad\x00path", "/bad\tpath"} {
		if _, err := config.ParseFlags([]string{"--probe", "--codex-home", path}); err == nil {
			t.Fatalf("accepted unsafe home %q", path)
		}
	}
	path := filepath.Join(t.TempDir(), "not-created & space")
	cfg, err = config.ParseFlags([]string{"--probe", "--codex-home", path})
	if err != nil || cfg.CodexHome != path {
		t.Fatalf("explicit catalog lost: %+v %v", cfg, err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("configuration touched data directory: %v", err)
	}
}

func TestParseFlags_Validations(t *testing.T) {
	// 1. Missing token
	_, err := config.ParseFlags([]string{"-node-id", "demoair", "-controller-url", "ws://127.0.0.1:8790/v1/daemon", "-token-env", "NON_EXISTENT_ENV_TOKEN_XYZ"})
	if err == nil {
		t.Fatalf("expected error for missing token")
	}

	// 2. Token from file
	tmpDir := t.TempDir()
	tokenPath := filepath.Join(tmpDir, "node.token")
	if err := os.WriteFile(tokenPath, []byte("test-secret-token"), 0600); err != nil {
		t.Fatalf("failed to write token file: %v", err)
	}

	cfg, err := config.ParseFlags([]string{
		"-node-id", "demoair",
		"-controller-url", "ws://127.0.0.1:8790/v1/daemon",
		"-token-file", tokenPath,
		"-heartbeat", "10",
	})
	if err != nil {
		t.Fatalf("unexpected error parsing flags: %v", err)
	}
	if cfg.NodeToken != "test-secret-token" {
		t.Fatalf("expected token 'test-secret-token', got %q", cfg.NodeToken)
	}
	if cfg.HeartbeatInterval.Seconds() != 10 {
		t.Fatalf("expected heartbeat 10s, got %v", cfg.HeartbeatInterval)
	}

	// 3. Invalid heartbeat (<= 0)
	_, err = config.ParseFlags([]string{
		"-node-id", "demoair",
		"-token-file", tokenPath,
		"-heartbeat", "0",
	})
	if err == nil {
		t.Fatalf("expected error for non-positive heartbeat interval")
	}

	// 4. Positional arguments forbidden (security against leaking tokens on CLI)
	_, err = config.ParseFlags([]string{
		"-node-id", "demoair",
		"-token-file", tokenPath,
		"extra-argument",
	})
	if err == nil {
		t.Fatalf("expected error for unexpected positional arguments")
	}

	// 5. Remote controller requires wss://
	_, err = config.ParseFlags([]string{
		"-node-id", "demoair",
		"-controller-url", "ws://remote.example.com/v1/daemon",
		"-token-file", tokenPath,
	})
	if err == nil {
		t.Fatalf("expected error for remote non-tls ws:// URL")
	}

	// Remote with wss:// is valid
	cfgRemote, err := config.ParseFlags([]string{
		"-node-id", "demoair",
		"-controller-url", "wss://remote.example.com/v1/daemon",
		"-token-file", tokenPath,
	})
	if err != nil {
		t.Fatalf("unexpected error for remote wss:// URL: %v", err)
	}
	if cfgRemote.ControllerURL != "wss://remote.example.com/v1/daemon" {
		t.Fatalf("unexpected url: %s", cfgRemote.ControllerURL)
	}

	// 6. Controller URL rejecting userinfo, query, fragment
	badURLs := []string{
		"wss://user:pass@remote.example.com/v1/daemon",
		"ws://127.0.0.1:8790/v1/daemon?token=secret",
		"ws://127.0.0.1:8790/v1/daemon#anchor",
	}
	for _, u := range badURLs {
		if err := config.ValidateControllerURL(u); err == nil {
			t.Fatalf("expected error validating insecure URL %q", u)
		}
	}
}

func TestServiceActionFlags(t *testing.T) {
	// 1. Valid non-install action does not require token
	for _, action := range []string{"start", "stop", "restart", "status", "uninstall"} {
		cfg, err := config.ParseFlags([]string{"--node-id", "demoair", "--service", action})
		if err != nil {
			t.Fatalf("expected success for service action %q without token: %v", action, err)
		}
		if cfg.ServiceAction != action {
			t.Fatalf("expected ServiceAction %q, got %q", action, cfg.ServiceAction)
		}
	}

	// 2. Install requires token
	if _, err := config.ParseFlags([]string{"--node-id", "demoair", "--service", "install"}); err == nil {
		t.Fatal("expected error for service install without token")
	}

	// 3. Install with token succeeds
	tmpDir := t.TempDir()
	tokenPath := filepath.Join(tmpDir, "node.token")
	if err := os.WriteFile(tokenPath, []byte("test-token"), 0600); err != nil {
		t.Fatalf("write token file: %v", err)
	}
	cfg, err := config.ParseFlags([]string{
		"--node-id", "demoair",
		"--service", "install",
		"--token-file", tokenPath,
		"--controller-url", "ws://127.0.0.1:8790/v1/daemon",
	})
	if err != nil {
		t.Fatalf("unexpected error for service install: %v", err)
	}
	if cfg.ServiceAction != "install" {
		t.Fatalf("expected install, got %s", cfg.ServiceAction)
	}

	// 4. Invalid service action
	if _, err := config.ParseFlags([]string{"--node-id", "demoair", "--service", "invalid"}); err == nil {
		t.Fatal("expected error for invalid service action")
	}

	// 5. Exclusive modes
	if _, err := config.ParseFlags([]string{"--node-id", "demoair", "--probe", "--service", "status"}); err == nil {
		t.Fatal("expected error combining probe and service")
	}
	if _, err := config.ParseFlags([]string{"--node-id", "demoair", "--probe-skills", "--service", "status"}); err == nil {
		t.Fatal("expected error combining probe-skills and service")
	}
}

func TestSkillRoots(t *testing.T) {
	t.Setenv("SKILL_ROOTS", `["/one"]`)
	cfg, err := config.ParseFlags([]string{"--probe-skills", "--skill-root", "/two"})
	if err != nil || len(cfg.SkillRoots) != 2 || !cfg.ProbeSkills {
		t.Fatalf("expected two configured roots in readonly mode: %v, %v", cfg, err)
	}
	if _, err := config.ParseFlags([]string{"--probe-skills", "--skill-root", "relative"}); err == nil {
		t.Fatal("relative root must fail")
	}
	t.Setenv("SKILL_ROOTS", `not-json`)
	if _, err := config.ParseFlags([]string{"--probe-skills"}); err == nil {
		t.Fatal("invalid JSON must fail")
	}
}

func TestStateDirectoryFlagsDoNotCreateFiles(t *testing.T) {
	t.Setenv("DAEMON_STATE_DIR", "")
	cfg, err := config.ParseFlags([]string{"--probe"})
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(cfg.StateDir) {
		t.Fatal("default journal path is not absolute")
	}
	base := t.TempDir()
	envPath := filepath.Join(base, "env-journal")
	flagPath := filepath.Join(base, "flag-journal")
	t.Setenv("DAEMON_STATE_DIR", envPath)
	cfg, err = config.ParseFlags([]string{"--probe"})
	if err != nil || cfg.StateDir != envPath {
		t.Fatalf("env journal: %v %v", cfg, err)
	}
	cfg, err = config.ParseFlags([]string{"--probe-skills", "--state-dir", flagPath})
	if err != nil || cfg.StateDir != flagPath {
		t.Fatalf("flag journal: %v %v", cfg, err)
	}
	for _, path := range []string{envPath, flagPath} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("parse/probe touched journal path: %v", err)
		}
	}
	for _, path := range []string{"relative", "/tmp/bad\npath"} {
		if _, err := config.ParseFlags([]string{"--probe", "--state-dir", path}); err == nil {
			t.Fatal("unsafe state path accepted")
		}
	}
}
