//go:build darwin || linux

package skills

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

const (
	skillFIFOProbeEnv = "WECHAT_SKILL_FIFO_PROBE"
	skillFIFORootEnv  = "WECHAT_SKILL_FIFO_ROOT"
	skillFIFOTimeout  = 15 * time.Second
	skillSwapAttempts = 512
	skillFIFOFixture  = "---\nname: fifo-regression\n---\nInstructions.\n"
)

// A timed child process also bounds a regression in open(2), which cannot be
// canceled by a context and would leave a blocked goroutine in this test.
func TestSkillScanFIFONonblocking(t *testing.T) {
	if probe := os.Getenv(skillFIFOProbeEnv); probe != "" {
		root := os.Getenv(skillFIFORootEnv)
		switch probe {
		case "root":
			fifo := filepath.Join(root, "fifo-root")
			if err := unix.Mkfifo(fifo, 0600); err != nil {
				t.Fatal(err)
			}
			if items, err := Scan([]string{fifo}); err == nil || len(items) != 0 {
				t.Fatalf("FIFO root accepted: %v %v", items, err)
			}
		case "file-swap", "directory-swap":
			testSkillScanFIFOSwap(t, root, probe == "directory-swap")
		case "file-replaced-fifo", "directory-replaced-fifo", "file-replaced-directory", "directory-replaced-file":
			testSkillOpenAfterReplacement(t, root, probe)
		default:
			t.Fatalf("unknown FIFO probe %q", probe)
		}
		return
	}
	for _, probe := range []string{
		"root", "file-swap", "directory-swap",
		"file-replaced-fifo", "directory-replaced-fifo", "file-replaced-directory", "directory-replaced-file",
	} {
		t.Run(probe, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), skillFIFOTimeout)
			defer cancel()
			cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestSkillScanFIFONonblocking$", "-test.count=1", "-test.v")
			cmd.Env = append(os.Environ(), skillFIFOProbeEnv+"="+probe, skillFIFORootEnv+"="+t.TempDir())
			output, err := cmd.CombinedOutput()
			if ctx.Err() != nil {
				t.Fatalf("%s blocked past %v; child killed and reaped: %v\n%s", probe, skillFIFOTimeout, ctx.Err(), output)
			}
			if err != nil {
				t.Fatalf("%s: %v\n%s", probe, err, output)
			}
			t.Logf("%s", output)
		})
	}
}

func testSkillOpenAfterReplacement(t *testing.T, root, probe string) {
	t.Helper()
	name := "SKILL.md"
	directory := strings.HasPrefix(probe, "directory-")
	path := filepath.Join(root, name)
	if directory {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
	} else if err := os.WriteFile(path, []byte(skillFIFOFixture), 0600); err != nil {
		t.Fatal(err)
	}
	handle, err := openSkillRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := handle.Close(); err != nil {
			t.Error(err)
		}
	}()
	before, err := handle.Lstat(name)
	if err != nil {
		t.Fatal(err)
	}
	replacement := filepath.Join(root, ".replacement")
	switch {
	case strings.HasSuffix(probe, "-fifo"):
		err = unix.Mkfifo(replacement, 0600)
	case strings.HasSuffix(probe, "-directory"):
		err = os.Mkdir(replacement, 0700)
	case strings.HasSuffix(probe, "-file"):
		err = os.WriteFile(replacement, []byte(skillFIFOFixture), 0600)
	}
	if err != nil {
		t.Fatal(err)
	}
	if err := exchangeSkillEntries(path, replacement); err != nil {
		t.Fatal(err)
	}
	file, _, err := openSkillFile(handle, name, before.IsDir())
	if file != nil {
		if closeErr := file.Close(); closeErr != nil {
			t.Error(closeErr)
		}
		t.Fatalf("replacement accepted after Lstat: %s", probe)
	}
	if err == nil {
		t.Fatalf("replacement missing diagnostic: %s", probe)
	}
}

func testSkillScanFIFOSwap(t *testing.T, root string, directory bool) {
	t.Helper()
	path := filepath.Join(root, "SKILL.md")
	if directory {
		path = filepath.Join(root, "package")
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	document := path
	if directory {
		document = filepath.Join(path, "SKILL.md")
	}
	if err := os.WriteFile(document, []byte(skillFIFOFixture), 0600); err != nil {
		t.Fatal(err)
	}
	fifo := filepath.Join(root, ".fifo")
	if err := unix.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	stop, done := make(chan struct{}), make(chan error, 1)
	go func() {
		for {
			select {
			case <-stop:
				done <- nil
				return
			default:
				if err := exchangeSkillEntries(path, fifo); err != nil {
					done <- err
					return
				}
			}
		}
	}()
	defer func() {
		close(stop)
		if err := <-done; err != nil {
			t.Error(err)
		}
	}()
	diagnostics := 0
	for attempt := 0; attempt < skillSwapAttempts; attempt++ {
		items, err := Scan([]string{root})
		if err != nil {
			diagnostics++
		}
		for _, item := range items {
			if item.Name != "fifo-regression" {
				t.Fatalf("unexpected skill after replacement: %+v", item)
			}
		}
	}
	t.Logf("completed %d scans while atomically exchanging a FIFO (%d concurrent-change diagnostics)", skillSwapAttempts, diagnostics)
}
