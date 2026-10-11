package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
)

// NewManager returns the appropriate Manager for the current runtime platform.
func NewManager() (Manager, error) {
	return NewManagerWithRunnerAndHome(runtime.GOOS, &defaultRunner{}, "")
}

// NewManagerWithRunner allows constructing a platform manager with custom runner and GOOS for testing.
func NewManagerWithRunner(goos string, r Runner) (Manager, error) {
	return NewManagerWithRunnerAndHome(goos, r, "")
}

// NewManagerWithRunnerAndHome allows constructing a platform manager with custom runner, home, and GOOS for testing.
func NewManagerWithRunnerAndHome(goos string, r Runner, homeDir string) (Manager, error) {
	switch goos {
	case "darwin":
		return newDarwinManager(r, homeDir)
	case "linux":
		return newLinuxManager(r, homeDir)
	default:
		return nil, fmt.Errorf("%w: current GOOS is %q", ErrNotSupported, goos)
	}
}

// Execute performs the requested service action using the resolved manager.
func Execute(ctx context.Context, cfg *config.Config) error {
	mgr, err := NewManager()
	if err != nil {
		return err
	}
	switch strings.ToLower(cfg.ServiceAction) {
	case config.ServiceActionInstall:
		return mgr.Install(ctx, cfg)
	case config.ServiceActionStart:
		return mgr.Start(ctx)
	case config.ServiceActionStop:
		return mgr.Stop(ctx)
	case config.ServiceActionRestart:
		return mgr.Restart(ctx)
	case config.ServiceActionStatus:
		info, err := mgr.Status(ctx)
		if err != nil {
			return err
		}
		if !info.Installed {
			fmt.Printf("Service is not installed (%s)\n", info.Detail)
			return errors.New("service is not installed")
		}
		if info.Running {
			if info.PID > 0 {
				fmt.Printf("Service is running (PID %d)\n", info.PID)
			} else {
				fmt.Printf("Service is running (%s)\n", info.Detail)
			}
			return nil
		}
		fmt.Printf("Service is stopped (%s)\n", info.Detail)
		return errors.New("service is not running")
	case config.ServiceActionUninstall:
		return mgr.Uninstall(ctx)
	default:
		return fmt.Errorf("unknown service action: %s", cfg.ServiceAction)
	}
}

// EnsureNotRoot verifies that the process is running as a non-root user.
func EnsureNotRoot() error {
	if os.Geteuid() == 0 {
		return errors.New("running user service commands as root/sudo is strictly prohibited")
	}
	return nil
}
