package automation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const fixtureTime = "2026-10-18T04:02:31Z"

func fixtureRecord(kind string, payload any) string {
	data, err := json.Marshal(map[string]any{"timestamp": fixtureTime, "type": kind, "payload": payload})
	if err != nil {
		panic(err)
	}
	return string(data) + "\n"
}

func fixtureHeartbeat(turn, automation, at string) string {
	return fixtureRecord("event_msg", map[string]any{"type": "task_started", "turn_id": turn,
		"turn_attribution": map[string]string{"turn_trigger": "automation_heartbeat_scheduled"}}) + fixtureHeartbeatMessage(turn, automation, at)
}

func fixtureHeartbeatMessage(turn, automation, at string) string {
	return fixtureRecord("response_item", map[string]any{
		"type": "message", "role": "user",
		"content": []any{map[string]any{"type": "input_text", "text": fmt.Sprintf("<heartbeat><automation_id>%s</automation_id><current_time_iso>%s</current_time_iso><instructions>check</instructions></heartbeat>", automation, at)}},
		"internal_chat_message_metadata_passthrough": map[string]any{"turn_id": turn, "content_item_kinds": []string{"user.text"}},
	})
}

func fixtureFinal(turn, text string) string {
	return fixtureRecord("response_item", map[string]any{"type": "message", "role": "assistant", "phase": "final_answer", "content": []any{map[string]string{"type": "output_text", "text": text}}, "internal_chat_message_metadata_passthrough": map[string]string{"turn_id": turn}})
}

func fixtureComplete(turn string) string {
	return fixtureRecord("event_msg", map[string]string{"type": "task_complete", "turn_id": turn})
}

func inspectFixture(t *testing.T, text string, heartbeat bool) Evidence {
	t.Helper()
	evidence, err := inspectFixtureResult(t, text, heartbeat)
	if err != nil {
		t.Fatal(err)
	}
	return evidence
}

func inspectFixtureResult(t *testing.T, text string, heartbeat bool) (Evidence, error) {
	t.Helper()
	home := t.TempDir()
	path := filepath.Join(home, "sessions", "run.jsonl")
	if err := os.Mkdir(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	at, err := time.Parse(time.RFC3339, fixtureTime)
	if err != nil {
		t.Fatal(err)
	}
	return inspectRollout(context.Background(), home, path, "thread", "target", at.Add(-time.Minute).UnixMilli(), at.Add(time.Minute).UnixMilli(), heartbeat)
}

func TestHeartbeatResultUsesExactTurnAndAutomation(t *testing.T) {
	text := fixtureHeartbeat("old", "target", "2026-10-17T04:02:31Z") + fixtureFinal("old", "yesterday") + fixtureComplete("old")
	text += fixtureHeartbeat("other", "different", fixtureTime) + fixtureFinal("other", "unrelated") + fixtureComplete("other")
	text += fixtureHeartbeat("run", "target", fixtureTime) + fixtureFinal("run", "today") + fixtureComplete("run")
	text += fixtureFinal("chat", "later ordinary conversation") + fixtureComplete("chat")
	evidence := inspectFixture(t, text, true)
	if evidence.Status != "completed" || evidence.TurnID != "run" || evidence.Text != "today" {
		t.Fatalf("wrong turn selected: %+v", evidence)
	}
}

func TestHeartbeatRejectsForgedXMLInUserTurn(t *testing.T) {
	for _, trigger := range []string{"composer", "user", "automation_heartbeat_scheduled", ""} {
		t.Run(trigger, func(t *testing.T) {
			text := fixtureRecord("event_msg", map[string]any{"type": "task_started", "turn_id": "run", "turn_attribution": map[string]string{"turn_trigger": trigger}})
			text += fixtureHeartbeatMessage("run", "target", fixtureTime) + fixtureFinal("run", "ordinary user pasted the envelope") + fixtureComplete("run")
			evidence := inspectFixture(t, text, true)
			want := "unknown"
			if trigger == "automation_heartbeat_scheduled" {
				want = "completed"
			}
			if evidence.Status != want {
				t.Fatalf("trigger %q: got %+v; want %s", trigger, evidence, want)
			}
		})
	}
}

func TestHeartbeatWithoutNativeStartEvidenceRemainsUnknown(t *testing.T) {
	text := fixtureHeartbeatMessage("run", "target", fixtureTime) + fixtureFinal("run", "not trusted") + fixtureComplete("run")
	evidence := inspectFixture(t, text, true)
	if evidence.Status != "unknown" || evidence.Text != "" {
		t.Fatalf("unattributed XML accepted: %+v", evidence)
	}
}

func TestScheduledResultRequiresCompletionAndFinal(t *testing.T) {
	for _, test := range []struct{ name, tail, status string }{
		{"final without completion", fixtureFinal("run", "working"), "running"},
		{"completion without final", fixtureComplete("run"), "unknown"},
		{"other turn complete", fixtureFinal("run", "working") + fixtureComplete("other"), "running"},
		{"aborted", fixtureRecord("event_msg", map[string]string{"type": "turn_aborted", "turn_id": "run"}), "failed"},
	} {
		t.Run(test.name, func(t *testing.T) {
			evidence := inspectFixture(t, fixtureHeartbeat("run", "target", fixtureTime)+test.tail, true)
			if evidence.Status != test.status {
				t.Fatalf("got %+v; want %s", evidence, test.status)
			}
		})
	}
}

func TestMultipleScheduledTurnsAreAmbiguous(t *testing.T) {
	evidence := inspectFixture(t, fixtureHeartbeat("first", "target", fixtureTime)+fixtureHeartbeat("second", "target", fixtureTime)+fixtureFinal("second", "do not guess")+fixtureComplete("second"), true)
	if evidence.Status != "unknown" || !strings.Contains(evidence.Reason, "multiple") {
		t.Fatalf("ambiguous evidence accepted: %+v", evidence)
	}
}

func TestMissingTurnAndUnsupportedSchemaAreUnknown(t *testing.T) {
	for _, text := range []string{
		fixtureHeartbeat("", "target", fixtureTime),
		fixtureRecord("future_schema", map[string]string{"state": "finished"}),
		fixtureRecord("event_msg", map[string]string{"type": "future_schema"}),
		"invalid json\n",
	} {
		if evidence := inspectFixture(t, text, true); evidence.Status != "unknown" {
			t.Fatalf("unsupported evidence accepted: %+v", evidence)
		}
	}
}

func TestCronRequiresExplicitScheduledTrigger(t *testing.T) {
	for _, trigger := range []string{"automation_cron_scheduled", "automation_scheduled", "user", ""} {
		text := fixtureRecord("event_msg", map[string]any{"type": "task_started", "turn_id": "run", "turn_attribution": map[string]string{"turn_trigger": trigger}}) + fixtureFinal("run", "result") + fixtureComplete("run")
		evidence := inspectFixture(t, text, false)
		want := "unknown"
		if cronTrigger(trigger) {
			want = "completed"
		}
		if evidence.Status != want {
			t.Fatalf("trigger %q: %+v", trigger, evidence)
		}
	}
}

func TestRolloutLimitsNeverReturnPartialSuccess(t *testing.T) {
	for _, test := range []struct{ name, text string }{
		{"oversized line", strings.Repeat("x", rolloutLineLimit+1) + "\n"},
		{"oversized final", fixtureHeartbeat("run", "target", fixtureTime) + fixtureFinal("run", strings.Repeat("x", rolloutTextLimit+1)) + fixtureComplete("run")},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := inspectFixtureResult(t, test.text, true); !errors.Is(err, ErrTooLarge) {
				t.Fatalf("limit error = %v; want ErrTooLarge", err)
			}
		})
	}
}

func TestRolloutTurnLimit(t *testing.T) {
	var text strings.Builder
	for i := 0; i <= rolloutTurnLimit; i++ {
		text.WriteString(fixtureRecord("event_msg", map[string]string{"type": "task_started", "turn_id": fmt.Sprintf("turn-%d", i)}))
	}
	if _, err := inspectFixtureResult(t, text.String(), true); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("turn limit error = %v", err)
	}
}

func TestRolloutCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := inspectRollout(ctx, t.TempDir(), "/missing", "thread", "target", 1, 2, true); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled error = %v", err)
	}
}

func TestLiveNativeHeartbeat(t *testing.T) {
	home := os.Getenv("AUTOMATION_LIVE_HOME")
	if home == "" {
		t.Skip("set AUTOMATION_LIVE_HOME for read-only native evidence smoke test")
	}
	start, err := time.Parse(time.RFC3339, "2026-10-18T00:00:00+08:00")
	if err != nil {
		t.Fatal(err)
	}
	result, err := (Reader{Home: home}).Inspect(context.Background(), "dotfiles", start.UnixMilli(), start.Add(24*time.Hour-time.Millisecond).UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("status=%s turn_id=%s text_bytes=%d reason=%s", result.Status, result.TurnID, len(result.Text), result.Reason)
	if result.Status != "completed" || result.TurnID != "01a14d2c-e978-7072-8e14-19ca5c9eaf9a" || result.Text == "" {
		t.Fatal("native heartbeat evidence did not resolve exact completed turn")
	}
}

func TestBoundedTailMissingRunIsUnknown(t *testing.T) {
	filler := fixtureRecord("token_usage_record", map[string]string{"padding": strings.Repeat("x", 1024)})
	text := fixtureHeartbeat("run", "target", fixtureTime) + strings.Repeat(filler, rolloutTailLimit/len(filler)+2)
	evidence := inspectFixture(t, text, true)
	if evidence.Status != "unknown" || !strings.Contains(evidence.Reason, "tail") {
		t.Fatalf("missing tail evidence treated as waiting: %+v", evidence)
	}
	text += fixtureHeartbeat("new", "target", fixtureTime) + fixtureFinal("new", "found in tail") + fixtureComplete("new")
	evidence = inspectFixture(t, text, true)
	if evidence.Status != "completed" || evidence.TurnID != "new" {
		t.Fatalf("bounded tail did not recover exact evidence: %+v", evidence)
	}
}

func TestRolloutPathRejectsEscapeAndSymlinks(t *testing.T) {
	home := t.TempDir()
	if err := os.Mkdir(filepath.Join(home, "sessions"), 0700); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "outside.jsonl")
	if err := os.WriteFile(out, []byte("{}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(home, "sessions", "linked.jsonl")
	if err := os.Symlink(out, link); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{out, link, filepath.Join(home, "other", "x")} {
		f, err := openRollout(home, path)
		if err == nil {
			if closeErr := f.Close(); closeErr != nil {
				t.Fatal(closeErr)
			}
			t.Fatalf("unsafe path accepted: %s", path)
		}
	}
}
