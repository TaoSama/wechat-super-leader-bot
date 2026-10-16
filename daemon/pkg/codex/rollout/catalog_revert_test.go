//go:build darwin || linux

package rollout

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	rolloutRevertThreadID = "019a0000-0000-7000-8000-000000000002"
	rolloutRevertLowerID  = "019a0000-0000-7000-8000-000000000001"
	rolloutRevertHigherID = "019a0000-0000-7000-8000-000000000003"
	rolloutRevertOldTime  = "2026-10-11T00-01-01"
	rolloutRevertNewTime  = "2026-10-11T00-01-02"
)

func writeRolloutRevertFixture(t *testing.T, home, date, timestamp, rolloutID string, meta map[string]any) string {
	t.Helper()
	dir := filepath.Join(home, "sessions", filepath.FromSlash(date))
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	suffix := rolloutRevertThreadID
	if rolloutID != "" {
		suffix += "_" + rolloutID
	}
	path := filepath.Join(dir, "rollout-"+timestamp+"-"+suffix+".jsonl")
	data := append(rolloutFixtureHeader(t, meta), []byte(rolloutFixtureSecret+"\xff INVALID BODY\n")...)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestRolloutCatalogRevertOrderingAndStableIdentity(t *testing.T) {
	for _, fixture := range []struct {
		name       string
		firstTime  string
		firstID    string
		secondTime string
		secondID   string
		want       string
	}{
		{"newer-time", rolloutRevertOldTime, rolloutRevertHigherID, rolloutRevertNewTime, rolloutRevertLowerID, "second"},
		{"uuid-tie", rolloutRevertNewTime, rolloutRevertLowerID, rolloutRevertNewTime, rolloutRevertHigherID, "second"},
		{"plain-beats-lower", rolloutRevertNewTime, "", rolloutRevertNewTime, rolloutRevertLowerID, "first"},
		{"compound-beats-plain", rolloutRevertNewTime, "", rolloutRevertNewTime, rolloutRevertHigherID, "second"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			home := rolloutFixtureHome(t)
			first := rolloutFixtureMeta(rolloutRevertThreadID, "vscode")
			second := rolloutFixtureMeta(rolloutRevertThreadID, "appServer")
			first["model_provider"], second["model_provider"] = "first", "second"
			first["timestamp"], second["timestamp"] = "2026-10-11T08:00:00Z", "2026-10-10T01:00:00Z"
			firstPath := writeRolloutRevertFixture(t, home, rolloutFixtureDate, fixture.firstTime, fixture.firstID, first)
			secondPath := writeRolloutRevertFixture(t, home, "2026/10/12", fixture.secondTime, fixture.secondID, second)
			// Both header time and file mtime disagree with filename ordering.
			firstMtime, secondMtime := time.Unix(2000, 0), time.Unix(1000, 0)
			if err := os.Chtimes(firstPath, firstMtime, firstMtime); err != nil {
				t.Fatal(err)
			}
			if err := os.Chtimes(secondPath, secondMtime, secondMtime); err != nil {
				t.Fatal(err)
			}
			writeRolloutIndex(t, home,
				rolloutTitleEntry(rolloutRevertThreadID, "stable title", "2026-10-10T00:00:00Z"),
				rolloutTitleEntry(rolloutRevertHigherID, "rollout must not own title", "2026-10-12T00:00:00Z"))
			before := snapshotRolloutFixture(t, home)
			catalog := NewRolloutCatalog(home)
			sessions, err := catalog.DiscoverSessions(context.Background())
			if err != nil || len(sessions) != 1 {
				t.Fatalf("sessions=%+v err=%v", sessions, err)
			}
			session := sessions[0]
			if session.ID != rolloutRevertThreadID || session.ModelProvider != fixture.want || session.Title != "stable title" || session.UpdatedAt != "" {
				t.Fatalf("wrong selected metadata or identity: %+v", session)
			}
			summary, err := catalog.ReadSession(context.Background(), rolloutRevertThreadID)
			if err != nil || strings.Contains(summary, rolloutFixtureSecret) {
				t.Fatalf("summary=%s err=%v", summary, err)
			}
			_, metadata, found := strings.Cut(summary, "\n")
			var read struct {
				Session                  protocol.Session `json:"session"`
				SessionMetadataTimestamp string           `json:"sessionMetadataTimestamp"`
				RolloutFileModifiedAt    string           `json:"rolloutFileModifiedAt"`
			}
			if !found || json.Unmarshal([]byte(metadata), &read) != nil || read.Session.ID != session.ID || read.Session.ModelProvider != fixture.want || read.Session.UpdatedAt != "" {
				t.Fatalf("Read disagrees with Discover: %s", summary)
			}
			wantTimestamp, wantMtime := first["timestamp"].(string), firstMtime
			if fixture.want == "second" {
				wantTimestamp, wantMtime = second["timestamp"].(string), secondMtime
			}
			if read.SessionMetadataTimestamp != wantTimestamp || read.RolloutFileModifiedAt != wantMtime.UTC().Format(time.RFC3339Nano) {
				t.Fatalf("summary times did not follow selected file: %s", summary)
			}
			if summary, err := catalog.ReadSession(context.Background(), rolloutRevertHigherID); err == nil || summary != "" {
				t.Fatalf("rollout UUID became a session: %s %v", summary, err)
			}
			assertRolloutFixtureUnchanged(t, home, before)
		})
	}
}

func TestRolloutCatalogRevertIdentityAndOldCorruptionFailClosed(t *testing.T) {
	for _, failure := range []string{"rollout-id", "suffix-id", "partial-old", "json-old", "invalid-rollout-uuid", "invalid-thread-uuid", "extra-suffix"} {
		t.Run(failure, func(t *testing.T) {
			home := rolloutFixtureHome(t)
			writeRolloutRevertFixture(t, home, rolloutFixtureDate, rolloutRevertNewTime, rolloutRevertHigherID, rolloutFixtureMeta(rolloutRevertThreadID, "cli"))
			meta := rolloutFixtureMeta(rolloutRevertThreadID, "cli")
			rolloutID := rolloutRevertLowerID
			switch failure {
			case "rollout-id":
				meta["id"] = rolloutRevertLowerID
			case "suffix-id":
				meta["id"] = rolloutRevertThreadID[len(rolloutRevertThreadID)-12:]
			case "invalid-rollout-uuid":
				rolloutID = "invalid"
			case "extra-suffix":
				rolloutID += "_" + rolloutRevertHigherID
			}
			path := writeRolloutRevertFixture(t, home, "2026/10/10", rolloutRevertOldTime, rolloutID, meta)
			if failure == "invalid-thread-uuid" {
				invalid := strings.Replace(filepath.Base(path), rolloutRevertThreadID, "invalid", 1)
				if err := os.Rename(path, filepath.Join(filepath.Dir(path), invalid)); err != nil {
					t.Fatal(err)
				}
			}
			if failure == "partial-old" || failure == "json-old" {
				data := rolloutFixtureHeader(t, meta)
				if failure == "partial-old" {
					data = data[:len(data)-1]
				} else {
					data = []byte("{bad}\n")
				}
				if err := os.WriteFile(path, data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			before := snapshotRolloutFixture(t, home)
			catalog := NewRolloutCatalog(home)
			if sessions, err := catalog.DiscoverSessions(context.Background()); err == nil || sessions != nil {
				t.Fatalf("invalid older candidate silently ignored: %+v %v", sessions, err)
			}
			if summary, err := catalog.ReadSession(context.Background(), rolloutRevertThreadID); err == nil || summary != "" {
				t.Fatalf("Read accepted partial observation: %s %v", summary, err)
			}
			assertRolloutFixtureUnchanged(t, home, before)
		})
	}
}

func TestRolloutCatalogRevertDuplicateOldKeyFailsInEveryVisitOrder(t *testing.T) {
	for _, newerPosition := range []int{0, 1, 2} {
		t.Run(string(rune('A'+newerPosition)), func(t *testing.T) {
			home := rolloutFixtureHome(t)
			dates := []string{"2026/10/10", "2026/10/11", "2026/10/12"}
			meta := rolloutFixtureMeta(rolloutRevertThreadID, "cli")
			for _, date := range dates {
				writeRolloutRevertFixture(t, home, date, rolloutRevertOldTime, rolloutRevertLowerID, meta)
			}
			// Determine actual directory traversal order, then place the newer
			// file at each position to cover A/B/A and B/A/A independently.
			root, err := openRolloutRoot(context.Background(), nil, filepath.Join(home, "sessions"))
			if err != nil {
				t.Fatal(err)
			}
			var paths []string
			err = walkRolloutDates(context.Background(), root, ".", 0, &rolloutBudget{}, func(path string) error {
				paths = append(paths, path)
				return nil
			})
			if closeErr := root.Close(); closeErr != nil {
				t.Fatal(closeErr)
			}
			if err != nil || len(paths) != len(dates) {
				t.Fatalf("paths=%v err=%v", paths, err)
			}
			path := filepath.Join(home, "sessions", paths[newerPosition])
			newName := strings.Replace(filepath.Base(path), rolloutRevertOldTime, rolloutRevertNewTime, 1)
			if err := os.Rename(path, filepath.Join(filepath.Dir(path), newName)); err != nil {
				t.Fatal(err)
			}
			before := snapshotRolloutFixture(t, home)
			if sessions, err := NewRolloutCatalog(home).DiscoverSessions(context.Background()); err == nil || sessions != nil || !strings.Contains(err.Error(), "duplicate file ordering key") {
				t.Fatalf("older duplicate ordering key accepted: %+v %v", sessions, err)
			}
			assertRolloutFixtureUnchanged(t, home, before)
		})
	}
}
