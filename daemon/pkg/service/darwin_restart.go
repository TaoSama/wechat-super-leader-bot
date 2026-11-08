package service

import (
	"context"
	"errors"
	"fmt"
	"time"
)

const (
	darwinUnloadTimeout      = 10 * time.Second
	darwinUnloadPollInterval = 100 * time.Millisecond
)

// waitForUnload requires absence rather than a stopped/running snapshot: bootout
// can still be removing the job when it returns, so neither permits Start yet.
func (m *DarwinManager) waitForUnload(ctx context.Context) error {
	waitCtx, cancel := context.WithTimeout(ctx, darwinUnloadTimeout)
	defer cancel()
	ticker := time.NewTicker(darwinUnloadPollInterval)
	defer ticker.Stop()

	for {
		if err := waitCtx.Err(); err != nil {
			return fmt.Errorf("wait for launchctl service unload: %w", err)
		}
		out, err := m.Runner.Run(waitCtx, "launchctl", "print", m.ServiceTarget())
		if contextErr := waitCtx.Err(); contextErr != nil {
			return fmt.Errorf("wait for launchctl service unload: %w", errors.Join(contextErr, err))
		}
		if err != nil {
			if launchServiceMissing(string(out)) {
				return nil
			}
			return fmt.Errorf("wait for launchctl service unload: %w", err)
		}
		select {
		case <-waitCtx.Done():
			return fmt.Errorf("wait for launchctl service unload: %w", waitCtx.Err())
		case <-ticker.C:
		}
	}
}
