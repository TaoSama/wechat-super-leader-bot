package skills_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/skills"
)

const fixture = "---\nname: 'build:review'\ndescription: >-\n  First line\n  second line\n---\nInstructions only.\n"

func put(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestScanNestedPackagesAndYAML(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "bundle", "skills", "review", "SKILL.md")
	put(t, path, []byte(fixture))
	put(t, filepath.Join(root, "bundle", "skills", "review", "references", "SKILL.md"), []byte("not installed independently"))
	items, err := skills.Scan([]string{root})
	if err != nil || len(items) != 1 {
		t.Fatalf("scan: %v %v", items, err)
	}
	item := items[0]
	if item.Name != "build:review" || item.Description != "First line second line" || len(item.ID) != 64 || len(item.Digest) != 64 {
		t.Fatalf("metadata: %+v", item)
	}
	if _, err := skills.Resolve([]string{root}, []skills.Ref{{ID: item.ID, Digest: item.Digest}}); err != nil {
		t.Fatal(err)
	}
	put(t, path, []byte(fixture+"changed"))
	if _, err := skills.Resolve([]string{root}, []skills.Ref{{ID: item.ID, Digest: item.Digest}}); err == nil {
		t.Fatal("stale content accepted")
	}
	if _, err := skills.Resolve([]string{root}, []skills.Ref{{ID: "missing", Digest: item.Digest}}); err == nil {
		t.Fatal("missing skill accepted")
	}
}

func TestSymlinkContainmentAndRootAlias(t *testing.T) {
	base := t.TempDir()
	root, outside := filepath.Join(base, "root"), filepath.Join(base, "outside")
	put(t, filepath.Join(root, "good", "SKILL.md"), []byte(fixture))
	put(t, filepath.Join(outside, "SKILL.md"), []byte(fixture))
	if err := os.Symlink(root, filepath.Join(root, "cycle")); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(base, "alias")
	if err := os.Symlink(root, alias); err != nil {
		t.Fatal(err)
	}
	items, err := skills.Scan([]string{root, alias})
	if err != nil || len(items) != 1 {
		t.Fatalf("root alias/cycle: %v %v", items, err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	items, err = skills.Scan([]string{root})
	if err == nil || len(items) != 1 || !strings.Contains(err.Error(), "outside permitted roots") {
		t.Fatalf("escape allowed: %v %v", items, err)
	}
	if _, err := skills.Resolve([]string{root}, []skills.Ref{{ID: items[0].ID, Digest: items[0].Digest}}); err == nil {
		t.Fatal("incomplete catalog should fail closed")
	}
	items, err = skills.Scan([]string{root, outside})
	if err != nil || len(items) != 2 {
		t.Fatalf("explicit second root: %v %v", items, err)
	}
}

func TestBrokenNestedSymlinkDoesNotMakeCatalogIncomplete(t *testing.T) {
	root := t.TempDir()
	put(t, filepath.Join(root, "valid", "SKILL.md"), []byte(fixture))
	if err := os.Symlink(filepath.Join(root, "missing"), filepath.Join(root, "stale-alias")); err != nil {
		t.Fatal(err)
	}

	items, err := skills.Scan([]string{root})
	if err != nil || len(items) != 1 || items[0].Name != "build:review" {
		t.Fatalf("stale nested alias made catalog incomplete: %v %v", items, err)
	}
}

func TestInvalidDocumentsAndBounds(t *testing.T) {
	for name, content := range map[string][]byte{
		"no-header": []byte("text only"), "bad-yaml": []byte("---\nname: [\n---\n"),
		"invalid-utf8": {255, 254}, "oversize": []byte(strings.Repeat("x", skills.MaxFileBytes+1)),
		"name-too-long": []byte("---\nname: " + strings.Repeat("n", skills.MaxNameBytes+1) + "\n---\n"),
	} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			put(t, filepath.Join(root, "SKILL.md"), content)
			items, err := skills.Scan([]string{root})
			if err == nil || len(items) != 0 {
				t.Fatalf("invalid document accepted: %v %v", items, err)
			}
		})
	}
	root := t.TempDir()
	put(t, filepath.Join(root, "SKILL.md"), []byte("---\nname: unicode\ndescription: "+strings.Repeat("😀", 200)+"\n---\n"))
	items, err := skills.Scan([]string{root})
	if err != nil || len(items) != 1 || !utf8.ValidString(items[0].Description) || len(items[0].Description) > skills.MaxDescriptionBytes {
		t.Fatalf("UTF8 truncation: %v %v", items, err)
	}
}

func TestDepthAndCountBudgets(t *testing.T) {
	root := t.TempDir()
	put(t, filepath.Join(root, strings.Repeat("deep/", skills.MaxDepth+1), "SKILL.md"), []byte(fixture))
	if _, err := skills.Scan([]string{root}); err == nil {
		t.Fatal("depth budget ignored")
	}
	if _, err := skills.Scan([]string{"relative"}); err == nil {
		t.Fatal("relative root accepted")
	}
	if _, err := skills.Resolve(nil, []skills.Ref{{}, {}}); err == nil {
		t.Fatal("reference count ignored")
	}
}
