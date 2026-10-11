package transcript

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const testID = "11111111-1111-4111-8111-111111111111"

func fixture(t *testing.T, agent, text string) (*Reader, Ref, string) {
	t.Helper()
	root := t.TempDir()
	var rel string
	switch agent {
	case "codex":
		rel = "2026/10/12/rollout-2026-10-12T01-02-03-" + testID + ".jsonl"
	case "claude":
		rel = "project/" + testID + ".jsonl"
	case "grok":
		rel = "project/" + testID + "/updates.jsonl"
	}
	path := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	return New(Config{Roots: map[string]string{agent: root}}), Ref{"herdr:" + agent, agent, "id", testID}, path
}

func meta() string {
	return `{"type":"session_meta","payload":{"id":"` + testID + `","source":"cli"}}` + "\n"
}
func codexText(text string) string {
	encoded, err := json.Marshal(text)
	if err != nil {
		panic(err)
	}
	return `{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":` + string(encoded) + `}]}}` + "\n"
}
func assertError(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil || err.Error() != want {
		t.Fatalf("error = %v, want %s", err, want)
	}
}
func appendText(t *testing.T, path, text string) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(text); err != nil {
		t.Error(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestFormatsAndPrivateFields(t *testing.T) {
	fixtures := map[string]string{
		"codex":  meta() + codexText("public") + `{"type":"response_item","payload":{"type":"message","role":"assistant","phase":"analysis","content":[{"type":"output_text","text":"SECRET_analysis"}]}}` + "\n" + `{"type":"response_item","payload":{"type":"reasoning","summary":[{"text":"SECRET_reasoning"}],"encrypted_content":"SECRET_encrypted"}}` + "\n" + `{"type":"response_item","payload":{"type":"function_call","name":"SECRET_tool","arguments":"SECRET_argument"}}` + "\n" + `{"type":"response_item","payload":{"type":"function_call_output","output":"SECRET_output"}}` + "\n" + `{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"SECRET_system"}]}}` + "\n",
		"claude": `{"type":"assistant","sessionId":"` + testID + `","message":{"role":"assistant","content":[{"type":"thinking","thinking":"SECRET_thinking"},{"type":"redacted_thinking","data":"SECRET_redacted"},{"type":"text","text":"public"},{"type":"tool_use","name":"SECRET_tool","input":{"password":"SECRET_input"}}]}}` + "\n" + `{"type":"user","sessionId":"` + testID + `","message":{"role":"user","content":[{"type":"tool_result","content":"SECRET_result"}]}}` + "\n" + `{"type":"assistant","sessionId":"` + testID + `","isSidechain":true,"message":{"role":"assistant","content":"SECRET_sidechain"}}` + "\n",
		"grok":   `{"method":"session/update","params":{"sessionId":"` + testID + `","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"public"}}}}` + "\n" + `{"method":"session/update","params":{"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"SECRET_thought"}}}}` + "\n" + `{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","rawInput":"SECRET_input","rawOutput":"SECRET_output"}}}` + "\n",
	}
	for agent, content := range fixtures {
		t.Run(agent, func(t *testing.T) {
			r, ref, _ := fixture(t, agent, content)
			page, generation, err := r.Read(context.Background(), ref, "", "", 50)
			if err != nil {
				t.Fatal(err)
			}
			if len(page.Items) != 1 || page.Items[0].Text != "public" || generation == "" {
				t.Fatalf("bad page: %+v", page)
			}
			if page.Items[0].TurnID != "" || page.Items[0].Status != "" {
				t.Fatal("invented turn or status")
			}
			if agent == "grok" && page.Items[0].Type != "transcript_chunk" {
				t.Fatal("chunk presented as full message")
			}
			encoded, err := json.Marshal(page)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(encoded), "SECRET") || strings.Contains(string(encoded), testID) {
				t.Fatal("private metadata leaked")
			}
		})
	}
}

func TestLatestEarlierAppendAndPartialLine(t *testing.T) {
	r, ref, path := fixture(t, "codex", meta()+codexText("one")+codexText("two")+codexText("three"))
	page, generation, err := r.Read(context.Background(), ref, "", "", 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 || page.Items[0].Text != "two" || page.Items[1].Text != "three" || page.NextCursor == nil {
		t.Fatalf("latest: %+v", page)
	}
	cursor, stableID := *page.NextCursor, page.Items[0].ID
	partial := codexText("four")
	appendText(t, path, partial[:len(partial)-1])
	page, sameGeneration, err := r.Read(context.Background(), ref, generation, "", 2)
	if err != nil {
		t.Fatal(err)
	}
	if sameGeneration != generation || len(page.Items) != 2 || page.Items[1].Text != "three" {
		t.Fatalf("partial consumed: %+v", page)
	}
	appendText(t, path, "\n")
	latest, _, err := r.Read(context.Background(), ref, generation, "", 2)
	if err != nil {
		t.Fatal(err)
	}
	if latest.Items[1].Text != "four" {
		t.Fatalf("append absent: %+v", latest)
	}
	older, _, err := r.Read(context.Background(), ref, generation, cursor, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(older.Items) != 1 || older.Items[0].Text != "one" || older.NextCursor != nil {
		t.Fatalf("earlier moved: %+v", older)
	}
	all, _, err := r.Read(context.Background(), ref, generation, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	if all.Items[1].ID != stableID {
		t.Fatal("append changed prior item identity")
	}
}

func TestGenerationRejectsMutation(t *testing.T) {
	for _, mutation := range []string{"same-size", "truncate", "replace", "delete", "root-replace"} {
		t.Run(mutation, func(t *testing.T) {
			r, ref, path := fixture(t, "codex", meta()+codexText("one"))
			_, generation, err := r.Read(context.Background(), ref, "", "", 10)
			if err != nil {
				t.Fatal(err)
			}
			switch mutation {
			case "same-size":
				if err := os.WriteFile(path, []byte(meta()+codexText("two")), 0600); err != nil {
					t.Fatal(err)
				}
			case "truncate":
				if err := os.Truncate(path, 5); err != nil {
					t.Fatal(err)
				}
			case "replace":
				if err := os.WriteFile(path+".replacement", []byte(meta()+codexText("one")), 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Rename(path+".replacement", path); err != nil {
					t.Fatal(err)
				}
			case "delete":
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
			case "root-replace":
				root := r.roots[ref.Agent]
				moved := root + "-moved"
				if err := os.Rename(root, moved); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() {
					if err := os.RemoveAll(moved); err != nil {
						t.Error(err)
					}
				})
				if err := os.Mkdir(root, 0700); err != nil {
					t.Fatal(err)
				}
			}
			_, _, err = r.Read(context.Background(), ref, generation, "", 10)
			assertError(t, err, protocol.HistoryContextExpired)
		})
	}
}

func TestBindingCursorResetAndTTL(t *testing.T) {
	r, ref, _ := fixture(t, "codex", meta()+codexText("one")+codexText("two"))
	page, generation, err := r.Read(context.Background(), ref, "", "", 1)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = r.Read(context.Background(), ref, generation, "not-issued", 1)
	assertError(t, err, protocol.HistoryContextExpired)
	other := ref
	other.Value = "22222222-2222-4222-8222-222222222222"
	_, _, err = r.Read(context.Background(), other, generation, "", 1)
	assertError(t, err, protocol.HistoryContextExpired)
	r.mu.Lock()
	r.states[generation].used = time.Now().Add(-GenerationTTL - time.Second)
	r.mu.Unlock()
	_, _, err = r.Read(context.Background(), ref, generation, *page.NextCursor, 1)
	assertError(t, err, protocol.HistoryContextExpired)
	_, generation, err = r.Read(context.Background(), ref, "", "", 1)
	if err != nil {
		t.Fatal(err)
	}
	r.Reset()
	_, _, err = r.Read(context.Background(), ref, generation, "", 1)
	assertError(t, err, protocol.HistoryContextExpired)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _, err = r.Read(ctx, ref, "", "", 1)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
}
