package claude

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	// MaxCatalogSessions keeps the most recently updated transcripts so the
	// inventory stays far below the Controller message budget.
	MaxCatalogSessions = 200
	maxProjectDirs     = 4096
	maxProjectEntries  = 8192
	maxHeadBytes       = 512 << 10
	maxHeadLineBytes   = 256 << 10
	maxTitleRunes      = 80
	// Claude truncates encoded project names longer than this and appends a hash.
	maxEncodedProjectName = 200
	transcriptSuffix      = ".jsonl"
)

var sessionUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var nonAlphanumeric = regexp.MustCompile(`[^A-Za-z0-9]`)

// transcriptInfo is the file-derived identity of one session.
type transcriptInfo struct {
	ID        string
	Path      string
	Cwd       string
	Title     string
	UpdatedAt time.Time
	Size      int64
}

type headMetadata struct {
	cwd, title string
	size       int64
	modTime    time.Time
}

// encodeProjectName mirrors the CLI's directory naming for a working directory.
func encodeProjectName(cwd string) string { return nonAlphanumeric.ReplaceAllString(cwd, "-") }

func projectMatchesCwd(project, cwd string) bool {
	encoded := encodeProjectName(cwd)
	if len(encoded) <= maxEncodedProjectName {
		return project == encoded
	}
	return len(project) > maxEncodedProjectName && strings.HasPrefix(project, encoded[:maxEncodedProjectName])
}

// scanTranscripts lists regular <uuid>.jsonl files directly inside project
// directories. Symlinks are ignored so discovery never leaves the root.
func scanTranscripts(root string) ([]transcriptInfo, error) {
	projects, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	if len(projects) > maxProjectDirs {
		projects = projects[:maxProjectDirs]
	}
	var found []transcriptInfo
	for _, project := range projects {
		if project.Type()&os.ModeType != os.ModeDir {
			continue
		}
		dir := filepath.Join(root, project.Name())
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		if len(entries) > maxProjectEntries {
			entries = entries[:maxProjectEntries]
		}
		for _, entry := range entries {
			name := entry.Name()
			id := strings.TrimSuffix(name, transcriptSuffix)
			if !entry.Type().IsRegular() || !strings.HasSuffix(name, transcriptSuffix) || !sessionUUID.MatchString(id) {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				continue
			}
			found = append(found, transcriptInfo{ID: id, Path: filepath.Join(dir, name), UpdatedAt: info.ModTime(), Size: info.Size()})
		}
	}
	sort.Slice(found, func(a, b int) bool {
		if !found[a].UpdatedAt.Equal(found[b].UpdatedAt) {
			return found[a].UpdatedAt.After(found[b].UpdatedAt)
		}
		return found[a].Path < found[b].Path
	})
	if len(found) > MaxCatalogSessions {
		found = found[:MaxCatalogSessions]
	}
	return found, nil
}

type headRecord struct {
	Type        string          `json:"type"`
	SessionID   string          `json:"sessionId"`
	Cwd         string          `json:"cwd"`
	IsSidechain bool            `json:"isSidechain"`
	Summary     string          `json:"summary"`
	CustomTitle string          `json:"customTitle"`
	Message     json.RawMessage `json:"message"`
}

// readHead extracts the working directory and a display title from the
// transcript prefix. The cwd must belong to the same session record.
func readHead(path, id string) (cwd, title string, err error) {
	file, err := os.Open(path)
	if err != nil {
		return "", "", err
	}
	defer func() { err = errors.Join(err, file.Close()) }()
	reader := bufio.NewReaderSize(io.LimitReader(file, maxHeadBytes), maxHeadLineBytes)
	var prompt string
	for {
		line, readErr := reader.ReadSlice('\n')
		if len(line) > 0 && !errors.Is(readErr, bufio.ErrBufferFull) {
			var record headRecord
			if json.Unmarshal(line, &record) == nil {
				if cwd == "" && record.SessionID == id && cleanAbsolute(record.Cwd) {
					cwd = record.Cwd
				}
				switch {
				case record.Type == "custom-title" && record.CustomTitle != "":
					title = record.CustomTitle
				case record.Type == "summary" && record.Summary != "" && title == "":
					title = record.Summary
				case record.Type == "user" && !record.IsSidechain && prompt == "":
					prompt = promptText(record.Message)
				}
			}
		}
		if errors.Is(readErr, bufio.ErrBufferFull) {
			// Skip the remainder of an oversized line.
			for errors.Is(readErr, bufio.ErrBufferFull) {
				_, readErr = reader.ReadSlice('\n')
			}
			continue
		}
		if readErr != nil {
			break
		}
	}
	if cwd == "" {
		return "", "", errors.New("transcript has no session working directory")
	}
	if title == "" {
		title = prompt
	}
	return cwd, clipTitle(title), nil
}

func promptText(raw json.RawMessage) string {
	var message struct {
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(raw, &message) != nil {
		return ""
	}
	var text string
	if json.Unmarshal(message.Content, &text) != nil {
		var blocks []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(message.Content, &blocks) != nil {
			return ""
		}
		for _, block := range blocks {
			if block.Type == "text" {
				text = block.Text
				break
			}
		}
	}
	text = strings.TrimSpace(text)
	// Command wrappers and tool results are not a human prompt.
	if strings.HasPrefix(text, "<") {
		return ""
	}
	return text
}

func clipTitle(text string) string {
	text = strings.Join(strings.FieldsFunc(text, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }), " ")
	if !utf8.ValidString(text) {
		return ""
	}
	if utf8.RuneCountInString(text) <= maxTitleRunes {
		return text
	}
	return string([]rune(text)[:maxTitleRunes]) + "…"
}
