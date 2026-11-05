//go:build darwin || linux

package claude

import (
	"errors"
	"os/exec"
	"syscall"
	"time"
)

// killRetryDelay lets a second SIGKILL reach a child forked while the first
// signal was being delivered; the group survives as long as any member does.
const killRetryDelay = 50 * time.Millisecond

// isolateProcessGroup starts the CLI in its own process group so a timeout or
// shutdown signal reaches its tool subprocesses too.
func isolateProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func signalProcessGroup(cmd *exec.Cmd, signal syscall.Signal) error {
	if cmd.Process == nil {
		return errors.New("process not started")
	}
	err := syscall.Kill(-cmd.Process.Pid, signal)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}

func interruptProcessGroup(cmd *exec.Cmd) error { return signalProcessGroup(cmd, syscall.SIGINT) }

func killProcessGroup(cmd *exec.Cmd) error {
	if err := signalProcessGroup(cmd, syscall.SIGKILL); err != nil {
		return err
	}
	time.Sleep(killRetryDelay)
	return signalProcessGroup(cmd, syscall.SIGKILL)
}
