package service

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
)

type defaultRunner struct{}

func (*defaultRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	var path string
	switch name {
	case "launchctl":
		path = "/bin/launchctl"
	case "systemctl":
		path = "/usr/bin/systemctl"
	default:
		return nil, errors.New("unsupported service manager command")
	}
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Env = []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL=C"}
	for _, key := range []string{"HOME", "USER", "LOGNAME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"} {
		if value, ok := os.LookupEnv(key); ok && !strings.ContainsRune(value, 0) {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
	}
	return cmd.CombinedOutput()
}
