//go:build darwin || linux

package rollout

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestRolloutCatalogRootAndFileSymlinkConfinement(t *testing.T) {
	for _, target := range []string{"sessions-archive", "year-outside", "file-outside", "file-inside", "index-outside", "index-dangling"} {
		t.Run(target, func(t *testing.T) {
			home := rolloutFixtureHome(t)
			outside := t.TempDir()
			outsideFile := filepath.Join(outside, "private.jsonl")
			if err := os.WriteFile(outsideFile, rolloutFixtureHeader(t, rolloutFixtureMeta("session", "cli")), 0600); err != nil {
				t.Fatal(err)
			}
			path := rolloutFixturePath(home, "session")
			var link, destination string
			switch target {
			case "sessions-archive":
				archive := filepath.Join(home, "archived_sessions")
				if err := os.Rename(filepath.Join(home, "sessions"), archive); err != nil {
					t.Fatal(err)
				}
				link, destination = filepath.Join(home, "sessions"), "archived_sessions"
			case "year-outside":
				link, destination = filepath.Join(home, "sessions", "2027"), outside
			case "file-outside":
				link, destination = path, outsideFile
			case "file-inside":
				inside := filepath.Join(filepath.Dir(path), "private.txt")
				if err := os.WriteFile(inside, rolloutFixtureHeader(t, rolloutFixtureMeta("session", "cli")), 0600); err != nil {
					t.Fatal(err)
				}
				link, destination = path, "private.txt"
			case "index-outside":
				link, destination = filepath.Join(home, "session_index.jsonl"), outsideFile
			case "index-dangling":
				link, destination = filepath.Join(home, "session_index.jsonl"), "does-not-exist"
			}
			if err := os.Symlink(destination, link); err != nil {
				t.Fatal(err)
			}
			before, externalBefore := snapshotRolloutFixture(t, home), snapshotRolloutFixture(t, outside)
			if sessions, err := NewRolloutCatalog(home).DiscoverSessions(context.Background()); err == nil || sessions != nil || strings.Contains(err.Error(), outside) {
				t.Fatalf("symlink accepted/leaked: %+v %v", sessions, err)
			}
			assertRolloutFixtureUnchanged(t, home, before)
			assertRolloutFixtureUnchanged(t, outside, externalBefore)
		})
	}
}

func TestRolloutCatalogFIFONonblockingEveryOpenBoundary(t *testing.T) {
	for _, target := range []string{"home", "sessions", "year", "rollout", "index"} {
		t.Run(target, func(t *testing.T) {
			home := rolloutFixtureHome(t)
			var path string
			switch target {
			case "home":
				home = filepath.Join(t.TempDir(), "fifo-home")
				path = home
			case "sessions":
				home = t.TempDir()
				path = filepath.Join(home, "sessions")
			case "year":
				path = filepath.Join(home, "sessions", "2027")
			case "rollout":
				path = rolloutFixturePath(home, "session")
			case "index":
				writeRolloutFixture(t, home, "session", rolloutFixtureMeta("session", "cli"))
				path = filepath.Join(home, "session_index.jsonl")
			}
			if err := unix.Mkfifo(path, 0600); err != nil {
				t.Fatal(err)
			}
			started := time.Now()
			if sessions, err := NewRolloutCatalog(home).DiscoverSessions(context.Background()); err == nil || sessions != nil {
				t.Fatalf("FIFO accepted: %+v %v", sessions, err)
			}
			if time.Since(started) > time.Second {
				t.Fatal("FIFO open blocked")
			}
		})
	}
}

func TestRolloutCatalogOpenedTypeAndRootConfinementAfterReplacement(t *testing.T) {
	for _, replacement := range []string{"fifo", "directory", "outside-symlink", "missing"} {
		t.Run(replacement, func(t *testing.T) {
			home := rolloutFixtureHome(t)
			path := writeRolloutFixture(t, home, "session", rolloutFixtureMeta("session", "cli"))
			external := filepath.Join(t.TempDir(), "external.jsonl")
			if err := os.WriteFile(external, []byte(rolloutFixtureSecret), 0600); err != nil {
				t.Fatal(err)
			}
			root, err := openRolloutRoot(context.Background(), nil, filepath.Join(home, "sessions"))
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				if err := root.Close(); err != nil {
					t.Error(err)
				}
			}()
			started := time.Now()
			// Replacement happens after ReadDir delivered the regular entry,
			// immediately before the actual file open inside the visitor.
			err = walkRolloutDates(context.Background(), root, ".", 0, &rolloutBudget{}, func(relative string) error {
				if err := os.Remove(path); err != nil {
					return err
				}
				var err error
				switch replacement {
				case "fifo":
					err = unix.Mkfifo(path, 0600)
				case "directory":
					err = os.Mkdir(path, 0700)
				case "outside-symlink":
					err = os.Symlink(external, path)
				}
				if err != nil {
					return err
				}
				_, _, err = readRolloutHeader(context.Background(), root, relative, rolloutFixtureTimestamp, &rolloutBudget{})
				return err
			})
			if err == nil || strings.Contains(err.Error(), rolloutFixtureSecret) || time.Since(started) > time.Second {
				t.Fatalf("replacement boundary failed: %v", err)
			}
		})
	}
}

type rolloutCancelAtCheck struct {
	context.Context
	cancel    context.CancelFunc
	threshold int32
	checks    atomic.Int32
}

func (c *rolloutCancelAtCheck) Err() error {
	if c.checks.Add(1) >= c.threshold {
		c.cancel()
	}
	return c.Context.Err()
}

func rolloutFDCount(t *testing.T) int {
	t.Helper()
	// Darwin's /dev/fd enumeration may Stat already-closed synthetic entries.
	// The test's newly allocated descriptors are below this bounded range.
	const fixtureDescriptorLimit = 4096
	count := 0
	for descriptor := 0; descriptor < fixtureDescriptorLimit; descriptor++ {
		if _, err := unix.FcntlInt(uintptr(descriptor), unix.F_GETFD, 0); err == nil {
			count++
		} else if !errors.Is(err, unix.EBADF) {
			t.Fatal(err)
		}
	}
	return count
}

func TestRolloutCatalogCanceledRootClosesDirectoryFDs(t *testing.T) {
	home := rolloutFixtureHome(t)
	before := rolloutFDCount(t)
	const attempts = 100
	for i := 0; i < attempts; i++ {
		base, cancel := context.WithCancel(context.Background())
		// The third Err check is after the directory FD bridge completed.
		ctx := &rolloutCancelAtCheck{Context: base, cancel: cancel, threshold: 3}
		root, err := openRolloutRoot(ctx, nil, home)
		cancel()
		if root != nil || !errors.Is(err, context.Canceled) {
			if root != nil {
				if closeErr := root.Close(); closeErr != nil {
					t.Error(closeErr)
				}
			}
			t.Fatalf("canceled root returned a live handle: %v", err)
		}
	}
	if after := rolloutFDCount(t); after != before {
		t.Fatalf("directory handles leaked: before=%d after=%d", before, after)
	}
}

func TestRolloutCatalogCancellationDuringTraversal(t *testing.T) {
	home := rolloutFixtureHome(t)
	for _, id := range []string{"one", "two", "three", "four", "five"} {
		writeRolloutFixture(t, home, id, rolloutFixtureMeta(id, "cli"))
	}
	before := snapshotRolloutFixture(t, home)
	base, cancel := context.WithCancel(context.Background())
	defer cancel()
	ctx := &rolloutCancelAtCheck{Context: base, cancel: cancel, threshold: 35}
	if sessions, err := NewRolloutCatalog(home).DiscoverSessions(ctx); !errors.Is(err, context.Canceled) || sessions != nil {
		t.Fatalf("in-flight cancellation published a partial catalog: %+v %v", sessions, err)
	}
	assertRolloutFixtureUnchanged(t, home, before)
}
