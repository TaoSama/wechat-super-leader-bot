package service

import (
	"context"
	"errors"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
)

// Manager defines the interface for platform user service lifecycle.
type Manager interface {
	Install(ctx context.Context, cfg *config.Config) error
	Start(ctx context.Context) error
	Stop(ctx context.Context) error
	Restart(ctx context.Context) error
	Status(ctx context.Context) (StatusInfo, error)
	Uninstall(ctx context.Context) error
}

type StatusInfo struct {
	Installed bool
	Running   bool
	PID       int
	Detail    string
}

// Runner abstracts external process execution for testability.
type Runner interface {
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
}

// ErrNotSupported indicates that user services are not supported on this OS.
var ErrNotSupported = errors.New("platform user service is only supported on darwin (macOS LaunchAgent) and linux (systemd --user)")
