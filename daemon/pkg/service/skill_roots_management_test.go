package service

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
)

func TestManagementActionsReachFakeRunnerWithInvalidSkillRoots(t *testing.T) {
	t.Setenv("SKILL_ROOTS", "not-json")
	t.Setenv(config.DefaultTokenEnv, "")
	actions := []struct {
		name string
		run  func(Manager, context.Context) error
	}{
		{name: "start", run: Manager.Start},
		{name: "stop", run: Manager.Stop},
		{name: "restart", run: Manager.Restart},
		{name: "status", run: func(manager Manager, ctx context.Context) error {
			info, err := manager.Status(ctx)
			if err != nil {
				return err
			}
			if !info.Installed || !info.Running {
				return fmt.Errorf("unexpected fixture status: %+v", info)
			}
			return nil
		}},
		{name: "uninstall", run: Manager.Uninstall},
	}
	for _, platform := range []string{"darwin", "linux"} {
		for _, action := range actions {
			t.Run(platform+"/"+action.name, func(t *testing.T) {
				cfg, err := config.ParseFlags([]string{"--service", action.name})
				if err != nil || cfg.ServiceAction != action.name {
					t.Fatalf("management CLI blocked by unrelated skill configuration: cfg=%+v err=%v", cfg, err)
				}
				runner := &fakeRunner{handler: func(_ string, _ ...string) ([]byte, error) {
					if platform == "darwin" {
						return []byte("state = running\npid = 4242\n"), nil
					}
					return []byte("ActiveState=active\nSubState=running\nMainPID=4242\n"), nil
				}}
				manager := managementFixture(t, platform, runner)
				if err := action.run(manager, context.Background()); err != nil {
					t.Fatalf("isolated management action failed: %v", err)
				}
				if len(runner.calls) == 0 {
					t.Fatal("management action did not reach its injected runner")
				}
				t.Logf("%s %s reached fake runner: %+v", platform, action.name, runner.calls)
			})
		}
	}
}

func managementFixture(t *testing.T, platform string, runner Runner) Manager {
	t.Helper()
	homeDir := t.TempDir()
	manager, err := NewManagerWithRunnerAndHome(platform, runner, homeDir)
	if err != nil {
		t.Fatal(err)
	}
	binaryPath, err := ResolveManagedBinaryPath(homeDir)
	if err != nil {
		t.Fatal(err)
	}
	cfg := sampleConfig(t, filepath.Join(homeDir, "state"))
	tokenPath := ResolveTokenFilePath(cfg.StateDir)
	var servicePath, content string
	switch manager := manager.(type) {
	case *DarwinManager:
		servicePath = manager.ResolvePlistPath()
		content, err = GeneratePlistXML(binaryPath, cfg, tokenPath)
	case *LinuxManager:
		servicePath = manager.ResolveUnitPath()
		content, err = GenerateSystemdUnit(binaryPath, cfg, tokenPath)
	default:
		t.Fatalf("unsupported fixture manager %T", manager)
	}
	if err != nil {
		t.Fatal(err)
	}
	if err := AtomicWriteFile(servicePath, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	return manager
}
