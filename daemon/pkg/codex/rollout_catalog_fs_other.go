//go:build !darwin && !linux

package codex

import (
	"context"
	"os"
)

func openRolloutRoot(ctx context.Context, parent *os.Root, name string) (*os.Root, error) {
	return nil, rolloutError(ctx, "platform unsupported")
}

func openRolloutFile(ctx context.Context, root *os.Root, name string, directory bool) (*os.File, error) {
	return nil, rolloutError(ctx, "platform unsupported")
}
