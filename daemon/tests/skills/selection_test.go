package skills_test

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/skills"
)

func selectedFixture(t *testing.T) (string, []skills.Skill, []skills.Ref) {
	t.Helper()
	root := t.TempDir()
	for index := range skills.MaxSelectedSkills {
		path := filepath.Join(root, fmt.Sprintf("skill-%d", index), "SKILL.md")
		put(t, path, []byte(fixture+fmt.Sprintf("Fixture %d.\n", index)))
	}
	catalog, err := skills.Scan([]string{root})
	if err != nil || len(catalog) != skills.MaxSelectedSkills {
		t.Fatalf("catalog: %v, %v", catalog, err)
	}
	// User order deliberately differs from the catalog's path order.
	selected := []skills.Skill{catalog[3], catalog[1], catalog[0], catalog[2]}
	refs := make([]skills.Ref, len(selected))
	for index, item := range selected {
		refs[index] = skills.Ref{ID: item.ID, Digest: item.Digest}
	}
	return root, selected, refs
}

func TestSelectedSkillReferenceValidation(t *testing.T) {
	refs := make([]skills.Ref, skills.MaxSelectedSkills+1)
	for index := range refs {
		refs[index] = skills.Ref{ID: strings.Repeat(fmt.Sprintf("%x", index), 64), Digest: strings.Repeat("a", 64)}
	}
	for _, count := range []int{0, 1, skills.MaxSelectedSkills, skills.MaxSelectedSkills + 1} {
		t.Run(fmt.Sprintf("count-%d", count), func(t *testing.T) {
			original := append([]skills.Ref(nil), refs[:count]...)
			err := skills.ValidateRefs(refs[:count])
			if (err == nil) != (count <= skills.MaxSelectedSkills) {
				t.Fatalf("reference count %d: %v", count, err)
			}
			if count > 0 && !reflect.DeepEqual(refs[:count], original) {
				t.Fatal("validation changed reference order or values")
			}
		})
	}
	for name, invalid := range map[string][]skills.Ref{
		"duplicate":         {refs[0], refs[0]},
		"duplicate-version": {refs[0], {ID: refs[0].ID, Digest: strings.Repeat("b", 64)}},
		"uppercase-id":      {{ID: strings.Repeat("A", 64), Digest: refs[0].Digest}},
		"uppercase-digest":  {{ID: refs[0].ID, Digest: strings.Repeat("A", 64)}},
		"short-id":          {{ID: "a", Digest: refs[0].Digest}},
		"invalid-digest":    {{ID: refs[0].ID, Digest: strings.Repeat("g", 64)}},
	} {
		t.Run(name, func(t *testing.T) {
			if err := skills.ValidateRefs(invalid); err == nil {
				t.Fatal("invalid skill selection accepted")
			}
			if selected, err := skills.Resolve(nil, invalid); err == nil || len(selected) != 0 {
				t.Fatalf("invalid selection exposed partial executable skills: %v, %v", selected, err)
			}
		})
	}
}

func TestResolveAllSelectedSkillsInUserOrder(t *testing.T) {
	root, selected, refs := selectedFixture(t)
	for _, count := range []int{1, skills.MaxSelectedSkills} {
		resolved, err := skills.Resolve([]string{root}, refs[:count])
		if err != nil || !reflect.DeepEqual(resolved, selected[:count]) {
			t.Fatalf("ordered resolution of %d refs: %v, %v", count, resolved, err)
		}
	}
	if resolved, err := skills.Resolve([]string{"unavailable-root"}, nil); err != nil || len(resolved) != 0 {
		t.Fatalf("empty selection scanned a root: %v, %v", resolved, err)
	}
	extra := append(append([]skills.Ref{}, refs...), skills.Ref{ID: strings.Repeat("a", 64), Digest: strings.Repeat("b", 64)})
	if resolved, err := skills.Resolve([]string{root}, extra); err == nil || len(resolved) != 0 {
		t.Fatalf("over-limit selection returned executable skills: %v, %v", resolved, err)
	}
}

func TestResolveRejectsEntireSelectionWhenLaterSkillIsMissingOrChanged(t *testing.T) {
	for _, index := range []int{1, skills.MaxSelectedSkills - 1} {
		for _, failure := range []string{"missing", "changed"} {
			t.Run(fmt.Sprintf("position-%d-%s", index+1, failure), func(t *testing.T) {
				root, selected, refs := selectedFixture(t)
				path := selected[index].Path
				var err error
				if failure == "missing" {
					err = os.Remove(path)
				} else {
					err = os.WriteFile(path, []byte(fixture+"Changed."), 0600)
				}
				if err != nil {
					t.Fatal(err)
				}
				if resolved, err := skills.Resolve([]string{root}, refs); err == nil || len(resolved) != 0 {
					t.Fatalf("later failure exposed partial executable skills: %v, %v", resolved, err)
				}
			})
		}
	}
}
