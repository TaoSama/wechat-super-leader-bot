//go:build darwin || linux

package transcript

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"golang.org/x/sys/unix"
)

func TestFilesystemFailsClosed(t *testing.T) {
	for _, mutation := range []string{"symlink-file", "symlink-directory", "symlink-root", "fifo", "directory", "ambiguous", "depth"} {
		t.Run(mutation, func(t *testing.T) {
			r, ref, path := fixture(t, "codex", meta()+codexText("public"))
			root := r.roots["codex"]
			want := protocol.HistoryUnavailable
			switch mutation {
			case "symlink-file":
				outside := filepath.Join(t.TempDir(), "private.jsonl")
				if err := os.WriteFile(outside, []byte(meta()+codexText("SECRET")), 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, path); err != nil {
					t.Fatal(err)
				}
			case "symlink-directory":
				outside := t.TempDir()
				if err := os.RemoveAll(filepath.Join(root, "2026")); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, filepath.Join(root, "2026")); err != nil {
					t.Fatal(err)
				}
			case "symlink-root":
				link := filepath.Join(t.TempDir(), "records")
				if err := os.Symlink(root, link); err != nil {
					t.Fatal(err)
				}
				r = New(Config{Roots: map[string]string{"codex": link}})
			case "fifo":
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if err := unix.Mkfifo(path, 0600); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			case "ambiguous":
				second := filepath.Join(root, "rollout-other-"+testID+".jsonl")
				if err := os.WriteFile(second, []byte(meta()), 0600); err != nil {
					t.Fatal(err)
				}
			case "depth":
				if err := os.MkdirAll(filepath.Join(root, strings.Repeat("a/", MaxDepth+1)), 0700); err != nil {
					t.Fatal(err)
				}
				want = protocol.HistoryTooLarge
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_, _, err := r.Read(ctx, ref, "", "", 1)
			assertError(t, err, want)
			if strings.Contains(err.Error(), root) || strings.Contains(err.Error(), testID) {
				t.Fatal("path/identity leaked")
			}
		})
	}
}

func TestInvalidRecordsAndIdentity(t *testing.T) {
	for name, data := range map[string]string{
		"duplicate":    `{"type":"session_meta","payload":{"id":"` + testID + `","id":"another"}}` + "\n",
		"invalid-json": meta() + "{broken}\n",
		"surrogate":    meta() + `{"type":"future","text":"\ud800"}` + "\n",
		"invalid-utf8": meta() + "{\"text\":\"\xff\"}\n",
		"control":      meta() + codexText("bad\x1bcontrol"),
		"wrong-meta":   `{"type":"session_meta","payload":{"id":"22222222-2222-4222-8222-222222222222"}}` + "\n",
		"missing-meta": codexText("public"),
		"deep-json":    meta() + `{"type":"future","value":` + strings.Repeat("[", maxJSONDepth+2) + "0" + strings.Repeat("]", maxJSONDepth+2) + "}\n",
	} {
		t.Run(name, func(t *testing.T) {
			r, ref, _ := fixture(t, "codex", data)
			page, _, err := r.Read(context.Background(), ref, "", "", 1)
			if err == nil || len(page.Items) != 0 {
				t.Fatalf("invalid record accepted: %+v %v", page, err)
			}
		})
	}
	for _, agent := range []string{"claude", "grok"} {
		t.Run(agent+"-wrong-id", func(t *testing.T) {
			var data string
			if agent == "claude" {
				data = `{"type":"user","sessionId":"other","message":{"role":"user","content":"public"}}` + "\n"
			} else {
				data = `{"method":"session/update","params":{"sessionId":"other","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"public"}}}}` + "\n"
			}
			r, ref, _ := fixture(t, agent, data)
			_, _, err := r.Read(context.Background(), ref, "", "", 1)
			assertError(t, err, protocol.HistoryUnavailable)
		})
	}
	r, ref, _ := fixture(t, "codex", meta())
	for _, altered := range []Ref{{"herdr:codex", "codex", "path", testID}, {"test", "codex", "id", testID}, {"herdr:claude", "codex", "id", testID}, {"herdr:codex", "codex", "id", "../private"}} {
		if r.Supports(altered) {
			t.Fatalf("unsupported ref: %+v", altered)
		}
		_, _, err := r.Read(context.Background(), altered, "", "", 1)
		assertError(t, err, protocol.HistoryUnavailable)
	}
	_, _, err := r.Read(context.Background(), ref, "", "1", 1)
	assertError(t, err, protocol.HistoryInvalidRequest)
}

func TestBudgetsAndUnicode(t *testing.T) {
	t.Run("file", func(t *testing.T) {
		r, ref, path := fixture(t, "codex", meta())
		if err := os.Truncate(path, MaxFileBytes+1); err != nil {
			t.Fatal(err)
		}
		_, _, err := r.Read(context.Background(), ref, "", "", 1)
		assertError(t, err, protocol.HistoryTooLarge)
	})
	t.Run("line", func(t *testing.T) {
		r, ref, _ := fixture(t, "codex", meta()+codexText(strings.Repeat("a", MaxLineBytes)))
		_, _, err := r.Read(context.Background(), ref, "", "", 1)
		assertError(t, err, protocol.HistoryTooLarge)
	})
	t.Run("page", func(t *testing.T) {
		text := strings.Repeat("<>&", 10000)
		content := meta()
		for i := 0; i < protocol.MaxHistoryLimit; i++ {
			content += codexText(text)
		}
		r, ref, _ := fixture(t, "codex", content)
		page, generation, err := r.Read(context.Background(), ref, "", "", 50)
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(page.Items)
		if err != nil {
			t.Fatal(err)
		}
		if len(encoded) > MaxPageBytes || len(page.Items) == 0 || !page.Truncated || page.NextCursor == nil {
			t.Fatalf("bad budget %d: %+v", len(encoded), page)
		}
		for _, item := range page.Items {
			if len(item.Text) > MaxTextBytes {
				t.Fatal("UTF-8 budget exceeded")
			}
			if strings.ContainsRune(item.Text, '\ufffd') {
				t.Fatal("split UTF-8")
			}
		}
		older, _, err := r.Read(context.Background(), ref, generation, *page.NextCursor, 50)
		if err != nil || len(older.Items) == 0 {
			t.Fatalf("budget omitted data lost: %v", err)
		}
	})
}

func TestConcurrentReadsAndCapacity(t *testing.T) {
	r, ref, _ := fixture(t, "codex", meta()+codexText("public"))
	_, generation, err := r.Read(context.Background(), ref, "", "", 1)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			page, _, err := r.Read(context.Background(), ref, generation, "", 1)
			if err != nil && err.Error() != protocol.HistoryBusy {
				t.Error(err)
			}
			if err == nil && len(page.Items) != 1 {
				t.Error("missing item")
			}
		}()
	}
	wg.Wait()
	for i := 0; i < MaxConcurrentReads; i++ {
		r.slots <- struct{}{}
	}
	_, _, err = r.Read(context.Background(), ref, generation, "", 1)
	assertError(t, err, protocol.HistoryBusy)
	for i := 0; i < MaxConcurrentReads; i++ {
		<-r.slots
	}
	r.mu.Lock()
	for i := 0; i < MaxGenerations; i++ {
		r.states[strings.Repeat("x", i+1)] = &generationState{used: time.Now()}
	}
	r.mu.Unlock()
	_, _, err = r.Read(context.Background(), ref, "", "", 1)
	assertError(t, err, protocol.HistoryBusy)
}
