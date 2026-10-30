// Package skills discovers local instruction documents without executing them.
package skills

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"unicode"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

const (
	MaxSkills           = 256
	MaxEntries          = 10000
	MaxDepth            = 8
	MaxFileBytes        = 128 * 1024
	MaxNameBytes        = 128
	MaxDescriptionBytes = 500
	MaxPathBytes        = 1024
)

var ignoredDirectoryNames = map[string]struct{}{
	".git":         {},
	"node_modules": {},
	".venv":        {},
	"venv":         {},
	"__pycache__":  {},
}

func shouldSkipEntry(name string) bool {
	_, ok := ignoredDirectoryNames[name]
	return ok
}

type Skill struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Path        string `json:"path"`
	Digest      string `json:"digest"`
}
type permittedRoot struct {
	path   string
	handle *os.Root
}
type scanner struct {
	roots   []permittedRoot
	seen    map[string]bool
	entries int
	items   []Skill
	errors  []error
}

// Scan returns valid entries plus diagnostics when a catalog is incomplete.
func Scan(roots []string) ([]Skill, error) {
	s := &scanner{seen: make(map[string]bool), items: []Skill{}}
	for _, root := range roots {
		if !filepath.IsAbs(root) {
			s.problem(root, "root must be absolute")
			continue
		}
		real, err := filepath.EvalSymlinks(root)
		if err != nil {
			s.problem(root, "root unavailable")
			continue
		}
		handle, err := openSkillRoot(real)
		if err != nil {
			s.problem(root, "root cannot be opened")
			continue
		}
		s.roots = append(s.roots, permittedRoot{real, handle})
	}
	for _, root := range s.roots {
		s.walk(root.path, 0)
	}
	for _, root := range s.roots {
		if err := root.handle.Close(); err != nil {
			s.problem(root.path, "root close failed")
		}
	}
	sort.Slice(s.items, func(i, j int) bool { return s.items[i].Path < s.items[j].Path })
	return s.items, errors.Join(s.errors...)
}

func (s *scanner) problem(path, reason string) {
	s.errors = append(s.errors, fmt.Errorf("skill catalog %q: %s", path, reason))
}

func (s *scanner) locate(path string) (*os.Root, string) {
	for _, root := range s.roots {
		rel, err := filepath.Rel(root.path, path)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel) {
			return root.handle, rel
		}
	}
	return nil, ""
}

func isBrokenSymlink(path string, targetErr error) bool {
	if !errors.Is(targetErr, os.ErrNotExist) && !errors.Is(targetErr, syscall.ENOTDIR) {
		return false
	}
	info, err := os.Lstat(path)
	return err == nil && info.Mode()&os.ModeSymlink != 0
}

func (s *scanner) walk(path string, depth int) {
	if s.entries >= MaxEntries {
		s.problem(path, "entry limit reached")
		return
	}
	if depth > MaxDepth {
		s.problem(path, "depth limit reached")
		return
	}
	s.entries++
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		// A stale user-installed alias is unavailable by definition. Ignore only
		// broken symlinks; preserve diagnostics for permission failures, type
		// changes, and links that resolve outside the permitted roots.
		if isBrokenSymlink(path, err) {
			return
		}
		s.problem(path, "unresolvable path")
		return
	}
	if s.seen[real] {
		return
	}
	root, rel := s.locate(real)
	if root == nil {
		s.problem(path, "symlink target outside permitted roots")
		return
	}
	s.seen[real] = true
	info, err := root.Lstat(rel)
	if err != nil {
		s.problem(path, "path unavailable")
		return
	}
	if !info.IsDir() && (!info.Mode().IsRegular() || filepath.Base(real) != "SKILL.md") {
		return
	}
	file, info, err := openSkillFile(root, rel, info.IsDir())
	if err != nil {
		s.problem(path, "path cannot be opened safely")
		return
	}
	defer func() {
		if err := file.Close(); err != nil {
			s.problem(path, "file close failed")
		}
	}()
	if !info.IsDir() && info.Size() > MaxFileBytes {
		s.problem(path, "file too large")
		return
	}
	if info.IsDir() {
		entries, err := file.ReadDir(MaxEntries - s.entries + 1)
		if err != nil && !errors.Is(err, io.EOF) {
			s.problem(path, "directory cannot be read")
			return
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		// A skill package owns its references/assets; they are not independently
		// installed skills and must not expand discovery into arbitrary subtrees.
		for _, entry := range entries {
			if entry.Name() == "SKILL.md" {
				s.walk(filepath.Join(real, entry.Name()), depth+1)
				return
			}
		}
		for _, entry := range entries {
			if shouldSkipEntry(entry.Name()) {
				continue
			}
			if s.entries >= MaxEntries {
				s.problem(path, "entry limit reached")
				break
			}
			s.walk(filepath.Join(real, entry.Name()), depth+1)
		}
		return
	}
	if len(s.items) >= MaxSkills {
		s.problem(path, "skill count limit reached")
		return
	}
	content, err := io.ReadAll(io.LimitReader(file, MaxFileBytes+1))
	if err != nil {
		s.problem(path, "file cannot be read")
		return
	}
	if len(content) > MaxFileBytes || !utf8.Valid(content) {
		s.problem(path, "file exceeds size or UTF-8 constraints")
		return
	}
	item, err := parse(real, content)
	if err != nil {
		s.problem(path, err.Error())
		return
	}
	s.items = append(s.items, item)
}

func parse(path string, content []byte) (Skill, error) {
	lines := strings.Split(strings.ReplaceAll(string(content), "\r\n", "\n"), "\n")
	if len(lines) < 3 || lines[0] != "---" {
		return Skill{}, errors.New("missing YAML frontmatter")
	}
	end := 1
	for end < len(lines) && lines[end] != "---" {
		end++
	}
	if end == len(lines) {
		return Skill{}, errors.New("unclosed YAML frontmatter")
	}
	var meta struct {
		Name        string `yaml:"name"`
		Description string `yaml:"description"`
	}
	if err := yaml.Unmarshal([]byte(strings.Join(lines[1:end], "\n")), &meta); err != nil {
		return Skill{}, errors.New("invalid YAML metadata")
	}
	meta.Name = strings.TrimSpace(meta.Name)
	if meta.Name == "" || len(meta.Name) > MaxNameBytes || strings.ContainsFunc(meta.Name, unicode.IsControl) || len(path) > MaxPathBytes {
		return Skill{}, errors.New("invalid name or path length")
	}
	description := strings.Join(strings.Fields(meta.Description), " ")
	if len(description) > MaxDescriptionBytes {
		description = description[:MaxDescriptionBytes]
		for !utf8.ValidString(description) {
			description = description[:len(description)-1]
		}
	}
	return Skill{ID: fmt.Sprintf("%x", sha256.Sum256([]byte(path))), Name: meta.Name, Description: description, Path: path, Digest: fmt.Sprintf("%x", sha256.Sum256(content))}, nil
}

// Resolve never accepts arbitrary paths and refuses incomplete catalogs.
func Resolve(roots []string, refs []Ref) ([]Skill, error) {
	if err := ValidateRefs(refs); err != nil {
		return nil, err
	}
	if len(refs) == 0 {
		return []Skill{}, nil
	}
	catalog, err := Scan(roots)
	if err != nil {
		return nil, fmt.Errorf("cannot validate incomplete catalog: %w", err)
	}
	byID := make(map[string]Skill, len(catalog))
	for _, item := range catalog {
		byID[item.ID] = item
	}
	selected := make([]Skill, 0, len(refs))
	for _, ref := range refs {
		item, exists := byID[ref.ID]
		if !exists || item.Digest != ref.Digest {
			return nil, errors.New("selected skill missing or changed")
		}
		selected = append(selected, item)
	}
	return selected, nil
}
