//go:build darwin || linux

package codex

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"

	"golang.org/x/sys/unix"
)

const rolloutDirectoryFDPath = "/dev/fd/"

// OpenRoot itself opens before checking the type, without O_NONBLOCK or
// O_DIRECTORY. Bridge a held, already-opened directory FD instead of reopening
// an untrusted pathname that could be replaced with a FIFO in that interval.
func openRolloutRoot(ctx context.Context, parent *os.Root, name string) (root *os.Root, err error) {
	dir, err := openRolloutRootAnchor(ctx, parent, name)
	if err != nil {
		return nil, err
	}
	root, openErr := os.OpenRoot(rolloutDirectoryFDPath + strconv.FormatUint(uint64(dir.Fd()), 10))
	closeErr := rolloutClose(ctx, dir)
	if openErr != nil {
		return nil, errors.Join(rolloutError(ctx, "directory root unavailable"), closeErr)
	}
	if closeErr != nil {
		return nil, errors.Join(closeErr, rolloutClose(ctx, root))
	}
	if err := ctx.Err(); err != nil {
		return nil, errors.Join(err, rolloutClose(ctx, root))
	}
	return root, nil
}

func openRolloutRootAnchor(ctx context.Context, parent *os.Root, name string) (*os.File, error) {
	if parent == nil {
		return openRolloutFile(ctx, nil, name, true)
	}
	// The child root is a single directory, not an arbitrary relative path.
	// NOFOLLOW is enforced here because Root.OpenFile intentionally resolves
	// in-root symlinks, including a sessions link into archived_sessions.
	if filepath.Base(name) != name || name == "." || name == ".." {
		return nil, rolloutError(ctx, "directory root identity invalid")
	}
	anchor, err := openRolloutFile(ctx, parent, ".", true)
	if err != nil {
		return nil, err
	}
	fd, openErr := unix.Openat(int(anchor.Fd()), name, unix.O_RDONLY|unix.O_NONBLOCK|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	closeErr := rolloutClose(ctx, anchor)
	if openErr != nil {
		return nil, errors.Join(rolloutError(ctx, "directory root open failed"), closeErr)
	}
	dir := os.NewFile(uintptr(fd), name)
	if closeErr != nil {
		return nil, errors.Join(closeErr, rolloutClose(ctx, dir))
	}
	info, err := dir.Stat()
	if err != nil || !info.IsDir() {
		return nil, errors.Join(rolloutError(ctx, "directory root type invalid"), rolloutClose(ctx, dir))
	}
	return dir, nil
}

func openRolloutFile(ctx context.Context, root *os.Root, name string, directory bool) (*os.File, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	flags := os.O_RDONLY | unix.O_NONBLOCK
	if directory {
		flags |= unix.O_DIRECTORY
	}
	var file *os.File
	var err error
	if root == nil {
		file, err = os.OpenFile(name, flags, 0)
	} else {
		file, err = root.OpenFile(name, flags, 0)
	}
	if err != nil {
		// The index alone treats absence as normal; preserve ErrNotExist for
		// that caller without exposing the underlying path or error text.
		if errors.Is(err, os.ErrNotExist) {
			return nil, errors.Join(rolloutError(ctx, "file missing"), os.ErrNotExist)
		}
		return nil, rolloutError(ctx, "file open failed")
	}
	info, err := file.Stat()
	if err != nil || directory && !info.IsDir() || !directory && !info.Mode().IsRegular() {
		return nil, errors.Join(rolloutError(ctx, "file type invalid"), rolloutClose(ctx, file))
	}
	if err := ctx.Err(); err != nil {
		return nil, errors.Join(err, rolloutClose(ctx, file))
	}
	return file, nil
}
