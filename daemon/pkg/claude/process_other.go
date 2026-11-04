//go:build !(darwin || linux)

package claude

import (
	"errors"
	"os/exec"
)

var errUnsupportedPlatform = errors.New("Claude Code sessions are supported on darwin and linux only")

func isolateProcessGroup(*exec.Cmd)         {}
func interruptProcessGroup(*exec.Cmd) error { return errUnsupportedPlatform }
func killProcessGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return errUnsupportedPlatform
	}
	return cmd.Process.Kill()
}
