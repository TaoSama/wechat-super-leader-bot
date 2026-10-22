//go:build darwin || linux

package transcript

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	revertLowerID  = "00000000-0000-4000-8000-000000000000"
	revertHigherID = "22222222-2222-4222-8222-222222222222"
	revertOldTime  = "2026-10-12T01-02-03"
	revertNewTime  = "2026-10-12T01-02-04"
)

func writeRevertTranscript(t *testing.T, root, directory, timestamp, rolloutID, text string) string {
	t.Helper()
	id := testID
	if rolloutID != "" {
		id += "_" + rolloutID
	}
	path := filepath.Join(root, directory, "rollout-"+timestamp+"-"+id+".jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(meta()+codexText(text)), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCodexRevertSelectsLatestRollout(t *testing.T) {
	for _, test := range []struct {
		name, firstTime, firstID, secondTime, secondID, want string
	}{
		{"newer-time", revertOldTime, revertHigherID, revertNewTime, revertLowerID, "second"},
		{"uuid-tie", revertNewTime, revertLowerID, revertNewTime, revertHigherID, "second"},
		{"plain-beats-lower", revertNewTime, "", revertNewTime, revertLowerID, "first"},
		{"compound-beats-plain", revertNewTime, "", revertNewTime, revertHigherID, "second"},
		{"plain-newer-time", revertNewTime, "", revertOldTime, revertHigherID, "first"},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			first := writeRevertTranscript(t, root, "2026/10/12", test.firstTime, test.firstID, "first")
			second := writeRevertTranscript(t, root, "2026/10/13", test.secondTime, test.secondID, "second")
			// A touched old rollout must not outrank a newer immutable rollout.
			firstTime, secondTime := time.Unix(2000, 0), time.Unix(1000, 0)
			if err := os.Chtimes(first, firstTime, firstTime); err != nil {
				t.Fatal(err)
			}
			if err := os.Chtimes(second, secondTime, secondTime); err != nil {
				t.Fatal(err)
			}
			r := New(Config{Roots: map[string]string{"codex": root}})
			ref := Ref{"herdr:codex", "codex", "id", testID}
			page, _, err := r.Read(context.Background(), ref, "", "", 10)
			if err != nil || len(page.Items) != 1 || page.Items[0].Text != test.want {
				t.Fatalf("page=%+v err=%v, want %q", page, err, test.want)
			}
		})
	}
}

func TestCodexRevertCompoundOnlyAndLegacyNames(t *testing.T) {
	for _, name := range []string{
		"rollout-" + revertNewTime + "-" + testID + "_" + revertHigherID + ".jsonl",
		"rollout-" + revertNewTime + "-" + testID + ".jsonl",
		testID + "_legacy.jsonl",
	} {
		t.Run(name, func(t *testing.T) {
			r, ref, path := fixture(t, "codex", meta()+codexText("public"))
			if err := os.Rename(path, filepath.Join(filepath.Dir(path), name)); err != nil {
				t.Fatal(err)
			}
			page, _, err := r.Read(context.Background(), ref, "", "", 10)
			if err != nil || len(page.Items) != 1 || page.Items[0].Text != "public" {
				t.Fatalf("page=%+v err=%v", page, err)
			}
		})
	}
}

func TestCodexRevertExpiresPreviousGeneration(t *testing.T) {
	r, ref, _ := fixture(t, "codex", meta()+codexText("old one")+codexText("old two"))
	page, generation, err := r.Read(context.Background(), ref, "", "", 1)
	if err != nil || page.NextCursor == nil {
		t.Fatalf("page=%+v err=%v", page, err)
	}
	writeRevertTranscript(t, r.roots["codex"], "2026/10/12", revertNewTime, revertHigherID, "new branch")
	_, _, err = r.Read(context.Background(), ref, generation, *page.NextCursor, 1)
	assertError(t, err, protocol.HistoryContextExpired)
	page, nextGeneration, err := r.Read(context.Background(), ref, "", "", 1)
	if err != nil || nextGeneration == generation || len(page.Items) != 1 || page.Items[0].Text != "new branch" {
		t.Fatalf("page=%+v generation=%q err=%v", page, nextGeneration, err)
	}
}

func TestCodexRevertDetectedDuringLocationVerification(t *testing.T) {
	r, ref, path := fixture(t, "codex", meta()+codexText("old branch"))
	anchor, err := openAnchor(r.roots["codex"])
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := closeFile(anchor); err != nil {
			t.Error(err)
		}
	}()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	rel, err := filepath.Rel(r.roots["codex"], path)
	if err != nil {
		t.Fatal(err)
	}
	writeRevertTranscript(t, r.roots["codex"], "2026/10/12", revertNewTime, revertHigherID, "new branch")
	err = verifyLocation(context.Background(), anchor, r.roots["codex"], ref, rel, info)
	assertError(t, err, protocol.HistoryContextExpired)
}

func TestCodexRevertFailsClosedWithoutOldFallback(t *testing.T) {
	for _, mutation := range []string{"symlink", "directory", "invalid-id", "extra-suffix", "invalid-time", "wrong-meta", "broken-latest", "duplicate-key", "duplicate-old-key", "legacy-ambiguity"} {
		t.Run(mutation, func(t *testing.T) {
			r, ref, _ := fixture(t, "codex", meta()+codexText("STALE"))
			root := r.roots["codex"]
			rolloutID := revertHigherID
			if mutation == "invalid-id" {
				rolloutID = "invalid"
			} else if mutation == "extra-suffix" {
				rolloutID += "_" + revertLowerID
			}
			path := writeRevertTranscript(t, root, "2026/10/12", revertNewTime, rolloutID, "latest")
			switch mutation {
			case "symlink", "directory":
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if mutation == "directory" {
					if err := os.Mkdir(path, 0700); err != nil {
						t.Fatal(err)
					}
				} else {
					outside := filepath.Join(t.TempDir(), "private.jsonl")
					if err := os.WriteFile(outside, []byte(meta()+codexText("SECRET")), 0600); err != nil {
						t.Fatal(err)
					}
					if err := os.Symlink(outside, path); err != nil {
						t.Fatal(err)
					}
				}
			case "invalid-time":
				invalid := filepath.Join(filepath.Dir(path), "rollout-invalid-"+testID+"_"+revertHigherID+".jsonl")
				if err := os.Rename(path, invalid); err != nil {
					t.Fatal(err)
				}
			case "wrong-meta", "broken-latest":
				data := "{broken}\n"
				if mutation == "wrong-meta" {
					data = `{"type":"session_meta","payload":{"id":"` + revertHigherID + `","source":"cli"}}` + "\n"
				}
				if err := os.WriteFile(path, []byte(data), 0600); err != nil {
					t.Fatal(err)
				}
			case "duplicate-key":
				writeRevertTranscript(t, root, "2026/10/13", revertNewTime, revertHigherID, "duplicate")
			case "duplicate-old-key":
				writeRevertTranscript(t, root, "2026/10/13", revertOldTime, "", "duplicate old")
			case "legacy-ambiguity":
				if err := os.WriteFile(filepath.Join(root, testID+"_legacy.jsonl"), []byte(meta()), 0600); err != nil {
					t.Fatal(err)
				}
			}
			page, _, err := r.Read(context.Background(), ref, "", "", 10)
			if err == nil || len(page.Items) != 0 {
				t.Fatalf("unsafe candidate fell back to old transcript: page=%+v err=%v", page, err)
			}
		})
	}
}
