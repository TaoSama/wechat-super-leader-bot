package service

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
)

func seedInstalledService(t *testing.T, goos, home string, cfg *config.Config) (Manager, string, map[string]string) {
	t.Helper()
	managedBin, err := ResolveManagedBinaryPath(home)
	if err != nil {
		t.Fatal(err)
	}
	tokenPath := ResolveTokenFilePath(cfg.StateDir)
	var mgr Manager
	var servicePath, body string
	if goos == "darwin" {
		darwin := &DarwinManager{HomeDir: home, UID: 501}
		mgr, servicePath = darwin, darwin.ResolvePlistPath()
		body, err = GeneratePlistXML(managedBin, cfg, tokenPath)
	} else {
		linux := &LinuxManager{HomeDir: home}
		mgr, servicePath = linux, linux.ResolveUnitPath()
		body, err = GenerateSystemdUnit(managedBin, cfg, tokenPath)
	}
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		managedBin:  "existing managed executable",
		tokenPath:   cfg.NodeToken,
		servicePath: body,
	}
	for path, data := range files {
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		perm := os.FileMode(0600)
		if path == managedBin {
			perm = 0755
		} else if path == servicePath {
			perm = 0644
		}
		if err := os.WriteFile(path, []byte(data), perm); err != nil {
			t.Fatal(err)
		}
	}
	return mgr, servicePath, files
}

func setServiceRunner(mgr Manager, runner Runner) {
	switch m := mgr.(type) {
	case *DarwinManager:
		m.Runner = runner
	case *LinuxManager:
		m.Runner = runner
	}
}

func TestServiceReinstallRejectsInvalidConfigBeforeSideEffects(t *testing.T) {
	for _, goos := range []string{"darwin", "linux"} {
		for _, tc := range []struct {
			name   string
			change func(*config.Config)
			want   string
		}{
			{"empty-token", func(cfg *config.Config) { cfg.NodeToken = "" }, "node token"},
			{"blank-token", func(cfg *config.Config) { cfg.NodeToken = " \t" }, "node token"},
			{"multiline-token", func(cfg *config.Config) { cfg.NodeToken = "fixture\ninvalid" }, "node token"},
			{"carriage-return-token", func(cfg *config.Config) { cfg.NodeToken = "fixture\rinvalid" }, "node token"},
			{"nul-token", func(cfg *config.Config) { cfg.NodeToken = "fixture\x00invalid" }, "node token"},
			{"relative-state-dir", func(cfg *config.Config) { cfg.StateDir = "relative/state" }, "state-dir"},
			{"newline-state-dir", func(cfg *config.Config) { cfg.StateDir += "\ninvalid" }, "state-dir"},
			{"nul-state-dir", func(cfg *config.Config) { cfg.StateDir += "\x00invalid" }, "state-dir"},
			{"desktop-send-without-socket", func(cfg *config.Config) {
				cfg.DesktopSend, cfg.DesktopSocketPath = true, ""
			}, "desktop-send"},
		} {
			t.Run(goos+"/"+tc.name, func(t *testing.T) {
				home := filepath.Join(t.TempDir(), "home")
				cfg := sampleConfig(t, filepath.Join(t.TempDir(), "state"))
				mgr, _, files := seedInstalledService(t, goos, home, cfg)
				running := true
				runner := &fakeRunner{handler: func(_ string, args ...string) ([]byte, error) {
					if len(args) > 0 && (args[0] == "bootout" || (len(args) > 1 && args[1] == "stop")) {
						running = false
					}
					return nil, nil
				}}
				setServiceRunner(mgr, runner)
				tc.change(cfg)
				if err := mgr.Install(context.Background(), cfg); err == nil || !strings.Contains(err.Error(), tc.want) {
					t.Fatalf("expected %s error, got %v", tc.want, err)
				}
				if len(runner.calls) != 0 || !running {
					t.Fatalf("invalid configuration changed existing service: running=%t calls=%+v", running, runner.calls)
				}
				for path, before := range files {
					after, err := os.ReadFile(path)
					if err != nil || string(after) != before {
						t.Fatalf("invalid configuration changed existing file %s (read error: %v)", path, err)
					}
				}
			})
		}
	}
}

func TestLinuxReinstallRejectsInvalidArgumentBeforeSideEffects(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	cfg := sampleConfig(t, filepath.Join(t.TempDir(), "state"))
	mgr, _, files := seedInstalledService(t, "linux", home, cfg)
	runner := &fakeRunner{}
	setServiceRunner(mgr, runner)
	cfg.NodeID = "invalid\nnode"
	if err := mgr.Install(context.Background(), cfg); err == nil || !strings.Contains(err.Error(), "systemd argument") {
		t.Fatalf("invalid systemd argument was not rejected: %v", err)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("invalid argument reached service manager: %+v", runner.calls)
	}
	for path, before := range files {
		after, err := os.ReadFile(path)
		if err != nil || string(after) != before {
			t.Fatalf("invalid argument changed existing file %s (read error: %v)", path, err)
		}
	}
}

func TestServiceReinstallValidConfigKeepsLifecycleOrder(t *testing.T) {
	for _, goos := range []string{"darwin", "linux"} {
		t.Run(goos, func(t *testing.T) {
			home := filepath.Join(t.TempDir(), "home")
			cfg := sampleConfig(t, filepath.Join(t.TempDir(), "state"))
			mgr, servicePath, _ := seedInstalledService(t, goos, home, cfg)
			runner := &fakeRunner{}
			setServiceRunner(mgr, runner)
			cfg.NodeToken = "updated-fixture-token"
			cfg.NodeID = "updated-node"
			if err := mgr.Install(context.Background(), cfg); err != nil {
				t.Fatal(err)
			}
			var want []recordedCall
			if m, ok := mgr.(*DarwinManager); ok {
				want = []recordedCall{
					{name: "launchctl", args: []string{"bootout", m.ServiceTarget()}},
					{name: "launchctl", args: []string{"enable", m.ServiceTarget()}},
					{name: "launchctl", args: []string{"bootstrap", m.DomainTarget(), servicePath}},
				}
			} else {
				want = []recordedCall{
					{name: "systemctl", args: []string{"--user", "daemon-reload"}},
					{name: "systemctl", args: []string{"--user", "enable", "--now", LinuxUnitName}},
					{name: "systemctl", args: []string{"--user", "restart", LinuxUnitName}},
				}
			}
			if !reflect.DeepEqual(runner.calls, want) {
				t.Fatalf("unexpected reinstall order: %+v", runner.calls)
			}
			body, err := os.ReadFile(servicePath)
			if err != nil || !strings.Contains(string(body), cfg.NodeID) {
				t.Fatalf("updated service configuration missing (read error: %v)", err)
			}
			token, err := os.ReadFile(ResolveTokenFilePath(cfg.StateDir))
			if err != nil || string(token) != cfg.NodeToken {
				t.Fatalf("updated service token missing (read error: %v)", err)
			}
		})
	}
}
