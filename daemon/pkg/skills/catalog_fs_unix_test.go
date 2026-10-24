//go:build darwin || linux

package skills

import (
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestSkillOpenPreservesSymlinkConfinementAfterLstat(t *testing.T) {
	for _, inside := range []bool{true, false} {
		name := "outside"
		if inside {
			name = "inside"
		}
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "SKILL.md")
			if err := os.WriteFile(path, []byte(skillFIFOFixture), 0600); err != nil {
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
			before, err := handle.Lstat("SKILL.md")
			if err != nil {
				t.Fatal(err)
			}
			target := filepath.Join(root, "target.md")
			if !inside {
				target = filepath.Join(t.TempDir(), "target.md")
			}
			if err := os.WriteFile(target, []byte(skillFIFOFixture), 0600); err != nil {
				t.Fatal(err)
			}
			linkTarget := target
			if inside {
				linkTarget = filepath.Base(target)
			}
			replacement := filepath.Join(root, ".replacement")
			if err := os.Symlink(linkTarget, replacement); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(replacement, path); err != nil {
				t.Fatal(err)
			}
			file, _, err := openSkillFile(handle, "SKILL.md", before.IsDir())
			if file != nil {
				defer func() {
					if err := file.Close(); err != nil {
						t.Error(err)
					}
				}()
			}
			if !inside {
				if err == nil || file != nil {
					t.Fatalf("outside symlink opened after Lstat: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("in-root symlink rejected: %v", err)
			}
			content, err := io.ReadAll(file)
			if err != nil || string(content) != skillFIFOFixture {
				t.Fatalf("in-root symlink read failed: %v", err)
			}
		})
	}
}
