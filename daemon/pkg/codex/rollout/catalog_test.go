//go:build darwin || linux

package rollout

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const rolloutFixtureDate = "2026/10/11"
const rolloutFixtureTimestamp = "2026-10-11T00:01:02.123Z"
const rolloutFixtureSecret = "PRIVATE_BODY_NEVER_PARSE_OR_RETURN"

func rolloutFixtureHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, "sessions", filepath.FromSlash(rolloutFixtureDate)), 0700); err != nil {
		t.Fatal(err)
	}
	return home
}

func rolloutFixtureMeta(id string, source any) map[string]any {
	return map[string]any{"id": rolloutFixtureID(id), "cwd": "/fixture/project", "model_provider": "fixture-provider",
		"timestamp": rolloutFixtureTimestamp, "source": source,
		"base_instructions": map[string]any{"text": rolloutFixtureSecret}, "model": "must-not-guess", "reasoning_effort": "must-not-guess"}
}

func rolloutFixtureID(id string) string {
	if nativeID, valid := parseRolloutUUID(id); valid {
		return nativeID
	}
	digest := sha256.Sum256([]byte(id))
	return fmt.Sprintf("%x-%x-%x-%x-%x", digest[:4], digest[4:6], digest[6:8], digest[8:10], digest[10:16])
}

func rolloutFixtureHeader(t *testing.T, meta map[string]any) []byte {
	t.Helper()
	data, err := json.Marshal(map[string]any{"type": "session_meta", "timestamp": rolloutFixtureTimestamp, "payload": meta})
	if err != nil {
		t.Fatal(err)
	}
	return append(data, '\n')
}

func rolloutFixturePath(home, id string) string {
	return filepath.Join(home, "sessions", filepath.FromSlash(rolloutFixtureDate), "rollout-2026-10-11T00-01-02-"+rolloutFixtureID(id)+".jsonl")
}

func writeRolloutFixture(t *testing.T, home, id string, meta map[string]any) string {
	t.Helper()
	path := rolloutFixturePath(home, id)
	data := append(rolloutFixtureHeader(t, meta), []byte(rolloutFixtureSecret+"\xff INVALID BODY JSON\n")...)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func writeRolloutIndex(t *testing.T, home string, entries ...map[string]any) {
	t.Helper()
	var data []byte
	for _, entry := range entries {
		encoded, err := json.Marshal(entry)
		if err != nil {
			t.Fatal(err)
		}
		data = append(data, encoded...)
		data = append(data, '\n')
	}
	if err := os.WriteFile(filepath.Join(home, "session_index.jsonl"), data, 0600); err != nil {
		t.Fatal(err)
	}
}

func rolloutTitleEntry(id, title, timestamp string) map[string]any {
	return map[string]any{"id": rolloutFixtureID(id), "thread_name": title, "updated_at": timestamp}
}

type rolloutFixtureFile struct {
	Digest [32]byte
	Size   int64
	Mode   os.FileMode
	Mtime  time.Time
}

func snapshotRolloutFixture(t *testing.T, home string) map[string]rolloutFixtureFile {
	t.Helper()
	files := make(map[string]rolloutFixtureFile)
	err := filepath.WalkDir(home, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		var data []byte
		if info.Mode().IsRegular() {
			data, err = os.ReadFile(path)
		} else if info.Mode()&os.ModeSymlink != 0 {
			var link string
			link, err = os.Readlink(path)
			data = []byte(link)
		}
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(home, path)
		if err != nil {
			return err
		}
		files[relative] = rolloutFixtureFile{sha256.Sum256(data), info.Size(), info.Mode(), info.ModTime()}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func assertRolloutFixtureUnchanged(t *testing.T, home string, before map[string]rolloutFixtureFile) {
	t.Helper()
	if after := snapshotRolloutFixture(t, home); !reflect.DeepEqual(before, after) {
		t.Fatalf("catalog changed fixture files: before=%+v after=%+v", before, after)
	}
}

func TestRolloutCatalogMetadataOnlyAndSources(t *testing.T) {
	home := rolloutFixtureHome(t)
	for id, source := range map[string]any{"cli": "cli", "vscode": "vscode", "app": "appServer", "exec": "exec",
		"unknown": "future", "subagent": map[string]any{"subagent": map[string]any{"thread_spawn": true}}, "null": nil, "number": 7} {
		writeRolloutFixture(t, home, id, rolloutFixtureMeta(id, source))
	}
	parent := rolloutFixtureMeta("child", "cli")
	parent["parent_thread_id"] = "other-thread"
	writeRolloutFixture(t, home, "child", parent)
	writeRolloutIndex(t, home,
		rolloutTitleEntry("cli", "new title 中文", "2026-10-11T02:00:00Z"),
		rolloutTitleEntry("cli", "older title", "2026-08-01T00:00:00Z"),
		rolloutTitleEntry("not-a-rollout", "must not create identity", rolloutFixtureTimestamp))
	before := snapshotRolloutFixture(t, home)
	started := time.Now()
	catalog := NewRolloutCatalog(home)
	sessions, err := catalog.DiscoverSessions(context.Background())
	if err != nil || len(sessions) != 3 {
		t.Fatalf("sessions=%+v err=%v", sessions, err)
	}
	for _, session := range sessions {
		if session.Provider != codex.ProviderCodexApp || session.Status != "unknown" || session.Loaded == nil || *session.Loaded || !reflect.DeepEqual(session.Capabilities, []protocol.ActionType{protocol.ActionRead}) {
			t.Fatalf("metadata grants live authority: %+v", session)
		}
		if session.Model != "" || session.ReasoningEffort != "" || session.UpdatedAt != "" || session.Preview != "" || session.Cwd != "/fixture/project" || session.ModelProvider != "fixture-provider" {
			t.Fatalf("guessed/leaked metadata: %+v", session)
		}
		observed, err := time.Parse(time.RFC3339Nano, session.ObservedAt)
		if err != nil || observed.Before(started) || observed.After(time.Now()) {
			t.Fatalf("not an observation timestamp: %s err=%v", session.ObservedAt, err)
		}
		if session.ID == rolloutFixtureID("cli") && session.Title != "new title 中文" {
			t.Fatalf("latest matching title lost: %+v", session)
		}
	}
	summary, err := catalog.ReadSession(context.Background(), rolloutFixtureID("cli"))
	if err != nil || !strings.Contains(summary, rolloutSummaryNotice) || !strings.Contains(summary, "sessionMetadataTimestamp") || !strings.Contains(summary, "rolloutFileModifiedAt") || strings.Contains(summary, rolloutFixtureSecret) || strings.Contains(summary, "must-not-guess") || strings.Contains(summary, "base_instructions") {
		t.Fatalf("summary=%s err=%v", summary, err)
	}
	for _, id := range []string{"exec", "subagent", "child", "not-a-rollout", "missing", "", " white", "line\n", "\x01", "a/b", `a\b`, "\xff", "bad\ufffd", strings.Repeat("x", protocol.MaxHistoryIdentityLength+1)} {
		if validRolloutID(id) {
			id = rolloutFixtureID(id)
		}
		if summary, err := catalog.ReadSession(context.Background(), id); err == nil || summary != "" {
			t.Fatalf("invalid/excluded identity read: %q", id)
		}
	}
	if _, ok := any(catalog).(codex.SessionAdapter); ok {
		t.Fatal("catalog implements execution adapter")
	}
	if _, ok := any(catalog).(codex.HistoryReader); ok {
		t.Fatal("catalog advertises history")
	}
	assertRolloutFixtureUnchanged(t, home, before)
}

func TestRolloutCatalogMissingIndexAndArchivedMove(t *testing.T) {
	home := rolloutFixtureHome(t)
	path := writeRolloutFixture(t, home, "session", rolloutFixtureMeta("session", "vscode"))
	catalog := NewRolloutCatalog(home)
	before := snapshotRolloutFixture(t, home)
	sessions, err := catalog.DiscoverSessions(context.Background())
	if err != nil || len(sessions) != 1 || sessions[0].Title != "" {
		t.Fatalf("missing optional index: %+v %v", sessions, err)
	}
	assertRolloutFixtureUnchanged(t, home, before)
	archive := filepath.Join(home, "archived_sessions")
	if err := os.Mkdir(archive, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path, filepath.Join(archive, filepath.Base(path))); err != nil {
		t.Fatal(err)
	}
	writeRolloutIndex(t, home, rolloutTitleEntry("session", "stale index title", rolloutFixtureTimestamp))
	before = snapshotRolloutFixture(t, home)
	if sessions, err := catalog.DiscoverSessions(context.Background()); err != nil || len(sessions) != 0 {
		t.Fatalf("archived identity retained: %+v %v", sessions, err)
	}
	if summary, err := catalog.ReadSession(context.Background(), rolloutFixtureID("session")); err == nil || summary != "" {
		t.Fatalf("cached/archived rollout still readable: %s %v", summary, err)
	}
	assertRolloutFixtureUnchanged(t, home, before)
}

func TestRolloutCatalogMalformedHeaderFailsWholeObservation(t *testing.T) {
	for _, failure := range []string{"empty", "partial", "json", "utf8", "type", "payload", "missing-source", "id", "cwd", "timestamp", "relative-cwd", "control-cwd", "provider", "parent", "invalid-time", "mismatch"} {
		t.Run(failure, func(t *testing.T) {
			home := rolloutFixtureHome(t)
			writeRolloutFixture(t, home, "valid", rolloutFixtureMeta("valid", "cli"))
			meta := rolloutFixtureMeta("broken", "cli")
			switch failure {
			case "missing-source":
				delete(meta, "source")
			case "id", "cwd", "timestamp":
				delete(meta, failure)
			case "relative-cwd":
				meta["cwd"] = "relative/path"
			case "control-cwd":
				meta["cwd"] = "/path\n"
			case "provider":
				meta["model_provider"] = 7
			case "parent":
				meta["parent_thread_id"] = 7
			case "invalid-time":
				meta["timestamp"] = "not-a-time"
			case "mismatch":
				meta["id"] = "other"
			}
			data := rolloutFixtureHeader(t, meta)
			switch failure {
			case "empty":
				data = nil
			case "partial":
				data = data[:len(data)-1]
			case "json":
				data = []byte("{PRIVATE_BODY_NEVER_PARSE_OR_RETURN\n")
			case "utf8":
				data = []byte("\xff\n")
			case "type":
				data = []byte("{\"type\":\"response_item\",\"payload\":{}}\n")
			case "payload":
				data = []byte("{\"type\":\"session_meta\",\"payload\":null}\n")
			}
			if err := os.WriteFile(rolloutFixturePath(home, "broken"), data, 0600); err != nil {
				t.Fatal(err)
			}
			before := snapshotRolloutFixture(t, home)
			catalog := NewRolloutCatalog(home)
			if sessions, err := catalog.DiscoverSessions(context.Background()); err == nil || sessions != nil || strings.Contains(err.Error(), rolloutFixtureSecret) || strings.Contains(err.Error(), home) {
				t.Fatalf("corrupt observation published/leaked: %+v %v", sessions, err)
			}
			if summary, err := catalog.ReadSession(context.Background(), rolloutFixtureID("valid")); err == nil || summary != "" {
				t.Fatalf("partial inventory used for Read: %s %v", summary, err)
			}
			assertRolloutFixtureUnchanged(t, home, before)
		})
	}
}

func TestRolloutCatalogIndexErrorsFailWholeObservation(t *testing.T) {
	for _, data := range []string{"{bad}\n", `{"id":"session","thread_name":"partial","updated_at":"2026-10-11T00:00:00Z"}`, "{}\n", "{\"id\":\"session\",\"thread_name\":7,\"updated_at\":\"bad\"}\n"} {
		home := rolloutFixtureHome(t)
		writeRolloutFixture(t, home, "session", rolloutFixtureMeta("session", "cli"))
		if err := os.WriteFile(filepath.Join(home, "session_index.jsonl"), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
		before := snapshotRolloutFixture(t, home)
		if sessions, err := NewRolloutCatalog(home).DiscoverSessions(context.Background()); err == nil || sessions != nil {
			t.Fatalf("index corruption silently degraded: %+v %v", sessions, err)
		}
		assertRolloutFixtureUnchanged(t, home, before)
	}
}

func TestRolloutCatalogPreCanceledAndMissing(t *testing.T) {
	home := rolloutFixtureHome(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	catalog := NewRolloutCatalog(home)
	if sessions, err := catalog.DiscoverSessions(ctx); !errors.Is(err, context.Canceled) || sessions != nil {
		t.Fatalf("cancel ignored: %+v %v", sessions, err)
	}
	if summary, err := catalog.ReadSession(ctx, "session"); !errors.Is(err, context.Canceled) || summary != "" {
		t.Fatalf("read cancel ignored: %s %v", summary, err)
	}
	for _, path := range []string{"relative/home", filepath.Join(home, "missing"), t.TempDir()} {
		if sessions, err := NewRolloutCatalog(path).DiscoverSessions(context.Background()); err == nil || sessions != nil {
			t.Fatalf("missing/invalid root accepted: %+v %v", sessions, err)
		}
	}
}

func TestRolloutCatalogFilenameIdentityIsWholeSuffix(t *testing.T) {
	id := rolloutFixtureID("session")
	for _, fixture := range []struct {
		filename string
		id       string
		valid    bool
	}{
		{"rollout-2026-10-11T00-01-02-" + id + ".jsonl", id, true},
		{"rollout-2026-10-11T00-01-02-" + id + ".jsonl", id[len(id)-12:], false},
		{"rollout-2026-10-11T25-01-02-" + id + ".jsonl", id, false},
		{"rollout-unknown-format-" + id + ".jsonl", id, false},
	} {
		home := rolloutFixtureHome(t)
		path := filepath.Join(home, "sessions", filepath.FromSlash(rolloutFixtureDate), fixture.filename)
		meta := rolloutFixtureMeta(fixture.id, "cli")
		meta["id"] = fixture.id
		if err := os.WriteFile(path, rolloutFixtureHeader(t, meta), 0600); err != nil {
			t.Fatal(err)
		}
		sessions, err := NewRolloutCatalog(home).DiscoverSessions(context.Background())
		if fixture.valid && (err != nil || len(sessions) != 1 || sessions[0].ID != fixture.id) || !fixture.valid && (err == nil || sessions != nil) {
			t.Fatalf("filename=%s id=%s valid=%t sessions=%+v err=%v", fixture.filename, fixture.id, fixture.valid, sessions, err)
		}
	}
}
