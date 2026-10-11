//go:build darwin || linux

package transcript

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"golang.org/x/sys/unix"
)

func openAnchor(name string) (*os.File, error) {
	fd, err := unix.Open(name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, failure(protocol.HistoryUnavailable)
	}
	return os.NewFile(uintptr(fd), "transcript-root"), nil
}

func openChild(parent *os.File, name string, directory bool) (*os.File, error) {
	if name == "" || name == "." || name == ".." || filepath.Base(name) != name {
		return nil, failure(protocol.HistoryUnavailable)
	}
	flags := unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_NONBLOCK | unix.O_CLOEXEC
	if directory {
		flags |= unix.O_DIRECTORY
	}
	fd, err := unix.Openat(int(parent.Fd()), name, flags, 0)
	if err != nil {
		return nil, failure(protocol.HistoryUnavailable)
	}
	f := os.NewFile(uintptr(fd), "transcript-entry")
	info, err := f.Stat()
	if err != nil || (directory && !info.IsDir()) || (!directory && !info.Mode().IsRegular()) {
		return nil, errors.Join(failure(protocol.HistoryUnavailable), closeFile(f))
	}
	return f, nil
}

func closeFile(file *os.File) error {
	if err := file.Close(); err != nil {
		return failure(protocol.HistoryFailed)
	}
	return nil
}

func anchoredRoot(anchor *os.File) (*os.Root, error) {
	// OpenRoot is bridged through the held directory, so a pathname swap to
	// a FIFO or a link cannot redirect or block this open.
	root, err := os.OpenRoot("/dev/fd/" + strconv.FormatUint(uint64(anchor.Fd()), 10))
	if err != nil {
		return nil, failure(protocol.HistoryUnavailable)
	}
	return root, nil
}

func resolve(ctx context.Context, anchor *os.File, ref Ref) (string, error) {
	seen := 0
	match := ""
	var walk func(*os.File, string, int) error
	walk = func(dir *os.File, prefix string, depth int) (err error) {
		if err := ctx.Err(); err != nil {
			return err
		}
		root, err := anchoredRoot(dir)
		if err != nil {
			return err
		}
		defer func() {
			if closeErr := root.Close(); closeErr != nil {
				err = errors.Join(err, failure(protocol.HistoryFailed))
			}
		}()
		entriesFile, err := root.Open(".")
		if err != nil {
			return failure(protocol.HistoryUnavailable)
		}
		defer func() { err = errors.Join(err, closeFile(entriesFile)) }()
		for {
			entries, readErr := entriesFile.ReadDir(128)
			for _, entry := range entries {
				if err := ctx.Err(); err != nil {
					return err
				}
				seen++
				if seen > MaxEntries {
					return failure(protocol.HistoryTooLarge)
				}
				name := entry.Name()
				rel := filepath.Join(prefix, name)
				if entry.Type()&os.ModeSymlink != 0 {
					if candidate(ref, rel) {
						return failure(protocol.HistoryUnavailable)
					}
					continue
				}
				if entry.IsDir() {
					if name == "subagents" || name == "archived_sessions" {
						continue
					}
					if depth >= MaxDepth {
						return failure(protocol.HistoryTooLarge)
					}
					child, openErr := openChild(dir, name, true)
					if openErr != nil {
						return openErr
					}
					walkErr := walk(child, rel, depth+1)
					if err := errors.Join(walkErr, closeFile(child)); err != nil {
						return err
					}
				} else if candidate(ref, rel) {
					if !entry.Type().IsRegular() || match != "" {
						return failure(protocol.HistoryUnavailable)
					}
					match = rel
				}
			}
			if readErr != nil {
				if errors.Is(readErr, os.ErrClosed) {
					return failure(protocol.HistoryUnavailable)
				}
				if errors.Is(readErr, io.EOF) {
					break
				}
				return failure(protocol.HistoryUnavailable)
			}
		}
		return nil
	}
	if err := walk(anchor, "", 0); err != nil {
		return "", err
	}
	if match == "" {
		return "", failure(protocol.HistoryUnavailable)
	}
	return match, nil
}

func candidate(ref Ref, rel string) bool {
	parts := strings.Split(filepath.ToSlash(rel), "/")
	name := parts[len(parts)-1]
	switch ref.Agent {
	case "codex":
		return strings.HasPrefix(name, "rollout-") && strings.HasSuffix(name, "-"+ref.Value+".jsonl") || strings.HasPrefix(name, ref.Value+"_") && strings.HasSuffix(name, ".jsonl")
	case "claude":
		return len(parts) == 2 && name == ref.Value+".jsonl"
	case "grok":
		return len(parts) == 3 && parts[1] == ref.Value && name == "updates.jsonl"
	}
	return false
}

func openRelative(anchor *os.File, rel string) (file *os.File, err error) {
	parts := strings.Split(filepath.ToSlash(rel), "/")
	parent := anchor
	var owned []*os.File
	defer func() {
		for _, dir := range owned {
			err = errors.Join(err, closeFile(dir))
		}
		if err != nil && file != nil {
			err = errors.Join(err, closeFile(file))
			file = nil
		}
	}()
	for index, part := range parts {
		child, openErr := openChild(parent, part, index < len(parts)-1)
		if openErr != nil {
			return nil, openErr
		}
		if index == len(parts)-1 {
			return child, nil
		}
		owned = append(owned, child)
		parent = child
	}
	return nil, failure(protocol.HistoryUnavailable)
}
