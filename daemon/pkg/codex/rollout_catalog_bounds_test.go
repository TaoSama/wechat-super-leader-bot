//go:build darwin || linux

package codex

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestRolloutCatalogHeaderExactByteBoundary(t *testing.T) {
	for _, extra := range []int{0, 1} {
		home := rolloutFixtureHome(t)
		meta := rolloutFixtureMeta("session", "cli")
		meta["padding"] = ""
		base := len(rolloutFixtureHeader(t, meta))
		meta["padding"] = strings.Repeat("x", maxRolloutHeaderBytes-base+extra)
		header := rolloutFixtureHeader(t, meta)
		if len(header) != maxRolloutHeaderBytes+extra {
			t.Fatal("invalid boundary fixture")
		}
		if err := os.WriteFile(rolloutFixturePath(home, "session"), header, 0600); err != nil {
			t.Fatal(err)
		}
		before := snapshotRolloutFixture(t, home)
		sessions, err := NewRolloutCatalog(home).DiscoverSessions(context.Background())
		if extra == 0 && (err != nil || len(sessions) != 1) || extra != 0 && (err == nil || sessions != nil) {
			t.Fatalf("header boundary extra=%d sessions=%+v err=%v", extra, sessions, err)
		}
		assertRolloutFixtureUnchanged(t, home, before)
	}
}

func TestRolloutCatalogMetadataUTF8BoundsAndNoBodyParsing(t *testing.T) {
	home := rolloutFixtureHome(t)
	meta := rolloutFixtureMeta("session", "cli")
	long := strings.Repeat("中文", maxSessionMetadataLength)
	meta["cwd"], meta["model_provider"] = "/"+long, long
	header := rolloutFixtureHeader(t, meta)
	const bodyBytes = 4 * 1024 * 1024
	data := append(header, bytes.Repeat([]byte{0xff}, bodyBytes)...)
	path := rolloutFixturePath(home, "session")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	writeRolloutIndex(t, home, rolloutTitleEntry("session", long, rolloutFixtureTimestamp))
	before := snapshotRolloutFixture(t, home)
	sessions, err := NewRolloutCatalog(home).DiscoverSessions(context.Background())
	if err != nil || len(sessions) != 1 {
		t.Fatalf("bounded metadata rejected: %+v %v", sessions, err)
	}
	for _, value := range []string{sessions[0].Cwd, sessions[0].Title} {
		if !utf8.ValidString(value) || len(value) > maxSessionMetadataLength {
			t.Fatal("metadata clipping split UTF-8")
		}
	}
	if !utf8.ValidString(sessions[0].ModelProvider) || len(sessions[0].ModelProvider) > 128 {
		t.Fatal("provider clipping split UTF-8")
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
	relative, err := filepath.Rel(filepath.Join(home, "sessions"), path)
	if err != nil {
		t.Fatal(err)
	}
	budget := &rolloutBudget{}
	if _, include, err := readRolloutHeader(context.Background(), root, relative, rolloutFixtureTimestamp, budget); err != nil || !include || budget.bytes > int64(len(header)+rolloutReadBufferBytes) {
		t.Fatalf("read beyond bounded first-line block: include=%t bytes=%d err=%v", include, budget.bytes, err)
	}
	assertRolloutFixtureUnchanged(t, home, before)
}

func TestRolloutCatalogAggregateAndEntryLimits(t *testing.T) {
	for _, remaining := range []int64{1, 0, -1} {
		budget := &rolloutBudget{bytes: maxRolloutReadBytes - remaining}
		reader := &rolloutBoundedReader{ctx: context.Background(), reader: strings.NewReader("xx"), budget: budget, limit: 10}
		if n, err := reader.Read(make([]byte, 10)); !errors.Is(err, errRolloutReadLimit) || n != 0 {
			t.Fatalf("aggregate limit bypass: n=%d err=%v", n, err)
		}
		if _, err := reader.Read(make([]byte, 10)); !errors.Is(err, errRolloutReadLimit) {
			t.Fatalf("second read after limit bypass: %v", err)
		}
	}
	home := rolloutFixtureHome(t)
	writeRolloutFixture(t, home, "one", rolloutFixtureMeta("one", "cli"))
	writeRolloutFixture(t, home, "two", rolloutFixtureMeta("two", "cli"))
	root, err := openRolloutRoot(context.Background(), nil, filepath.Join(home, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := root.Close(); err != nil {
			t.Error(err)
		}
	}()
	// Three date-directory entries and two rollout-file entries.
	for _, initial := range []int{maxRolloutEntries - 5, maxRolloutEntries - 4} {
		budget := &rolloutBudget{entries: initial}
		err := walkRolloutDates(context.Background(), root, ".", 0, budget, func(string) error { return nil })
		if initial == maxRolloutEntries-5 && err != nil || initial != maxRolloutEntries-5 && (err == nil || !strings.Contains(err.Error(), "limit")) {
			t.Fatalf("entry budget initial=%d err=%v", initial, err)
		}
	}
}

func TestRolloutCatalogIndexLineRecordAndByteLimits(t *testing.T) {
	for _, scenario := range []string{"line", "records", "bytes"} {
		t.Run(scenario, func(t *testing.T) {
			home := rolloutFixtureHome(t)
			writeRolloutFixture(t, home, "session", rolloutFixtureMeta("session", "cli"))
			var data []byte
			switch scenario {
			case "line":
				data = bytes.Repeat([]byte{'x'}, maxRolloutIndexLineBytes+1)
				data = append(data, '\n')
			case "records":
				line := []byte("{\"id\":\"session\",\"thread_name\":\"title\",\"updated_at\":\"2026-10-11T00:00:00Z\"}\n")
				data = bytes.Repeat(line, maxRolloutIndexRecords+1)
			case "bytes":
				line := []byte("{\"id\":\"session\",\"thread_name\":\"" + strings.Repeat("x", 2048) + "\",\"updated_at\":\"2026-10-11T00:00:00Z\"}\n")
				data = bytes.Repeat(line, maxRolloutIndexBytes/len(line)+1)
			}
			if err := os.WriteFile(filepath.Join(home, "session_index.jsonl"), data, 0600); err != nil {
				t.Fatal(err)
			}
			before := snapshotRolloutFixture(t, home)
			if sessions, err := NewRolloutCatalog(home).DiscoverSessions(context.Background()); err == nil || sessions != nil || !strings.Contains(err.Error(), "limit") {
				t.Fatalf("index cap bypass: %+v %v", sessions, err)
			}
			assertRolloutFixtureUnchanged(t, home, before)
		})
	}
}

func TestRolloutCatalogSessionAndControllerFrameCaps(t *testing.T) {
	for _, scenario := range []string{"sessions", "frame"} {
		t.Run(scenario, func(t *testing.T) {
			home := rolloutFixtureHome(t)
			count := maxRolloutSessions + 1
			if scenario == "frame" {
				count = maxRolloutFrameBytes/maxSessionMetadataLength + 1
			}
			for i := 0; i < count; i++ {
				id := fmt.Sprintf("session-%d", i)
				meta := rolloutFixtureMeta(id, "cli")
				if scenario == "frame" {
					meta["cwd"] = "/" + strings.Repeat("x", maxSessionMetadataLength-1)
				}
				writeRolloutFixture(t, home, id, meta)
			}
			want := "session limit"
			if scenario == "frame" {
				want = "frame limit"
			}
			if sessions, err := NewRolloutCatalog(home).DiscoverSessions(context.Background()); err == nil || sessions != nil || !strings.Contains(err.Error(), want) {
				t.Fatalf("%s cap bypass: %+v %v", scenario, sessions, err)
			}
		})
	}
}

type rolloutCancelingReader struct{ cancel context.CancelFunc }

func (r rolloutCancelingReader) Read(data []byte) (int, error) {
	n := copy(data, "{}\n")
	r.cancel()
	return n, nil
}

func TestRolloutCatalogCancellationDuringRead(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := &rolloutBoundedReader{ctx: ctx, reader: rolloutCancelingReader{cancel}, budget: &rolloutBudget{}, limit: maxRolloutHeaderBytes}
	if line, err := readRolloutLine(ctx, bufio.NewReaderSize(r, rolloutReadBufferBytes), maxRolloutHeaderBytes); !errors.Is(err, context.Canceled) || line != nil {
		t.Fatalf("read cancellation lost: %q %v", line, err)
	}
}
