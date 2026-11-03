package automation

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func inspectWindowFixture(t *testing.T, text string, expected, until int64, heartbeat bool) Evidence {
	t.Helper()
	home := t.TempDir()
	path := filepath.Join(home, "sessions", "run.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	out, err := inspectRollout(context.Background(), home, path, "thread", "target", expected, until, heartbeat)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func completedHeartbeatAt(turn, automation string, at int64) string {
	timestamp := time.UnixMilli(at).UTC().Format(time.RFC3339Nano)
	text := fixtureHeartbeat(turn, automation, timestamp) + fixtureFinal(turn, "exact result") + fixtureComplete(turn)
	return strings.ReplaceAll(text, fixtureTime, timestamp)
}

func TestReaderMatchesEarlyNativeHeartbeatWithoutChangingRequestedWindow(t *testing.T) {
	r, _ := readerFixture(t, "heartbeat")
	expected := time.Date(2026, 11, 3, 0, 0, 0, 0, time.UTC).UnixMilli()
	until := expected + int64(2*time.Hour/time.Millisecond)
	turn := "01a19eb2-972e-75b0-a484-55922f14735c"
	text := fixtureRecord("session_meta", map[string]string{"id": "thread"})
	text += strings.ReplaceAll(fixtureHeartbeat(turn, "target", "2026-11-02T23:57:46.665Z"), fixtureTime, "2026-11-02T23:57:46.697Z")
	text += strings.ReplaceAll(fixtureFinal(turn, "scheduled daily report"), fixtureTime, "2026-11-03T00:02:02.308Z")
	text += strings.ReplaceAll(fixtureComplete(turn), fixtureTime, "2026-11-03T00:02:02.347Z")
	path := filepath.Join(r.Home, "sessions", "early-heartbeat.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	db := dbFixture(t, filepath.Join(r.Home, "state_5.sqlite"), "")
	if _, err := db.Exec("insert into threads values('thread',?)", path); err != nil {
		t.Fatal(err)
	}
	out, err := r.Inspect(context.Background(), "target", expected, until)
	if err != nil || out.Status != "completed" || out.SessionID != "thread" || out.TurnID != turn || out.Text != "scheduled daily report" {
		t.Fatalf("early native heartbeat: %+v err=%v", out, err)
	}
	if out.ExpectedAt != expected || out.NotAfter != until {
		t.Fatalf("inspection changed the caller's window: %+v", out)
	}
}

func TestHeartbeatEarlyToleranceWindowBoundaries(t *testing.T) {
	expected := time.Date(2026, 11, 3, 0, 0, 0, 0, time.UTC).UnixMilli()
	until := expected + int64(2*time.Hour/time.Millisecond)
	for _, test := range []struct {
		name   string
		at     int64
		status string
	}{
		{"five minutes early", expected - 300_000, "completed"},
		{"outside early tolerance", expected - 300_001, "waiting"},
		{"reported scheduler drift", expected - 133_335, "completed"},
		{"just before nominal start", expected - 1, "completed"},
		{"nominal start", expected, "completed"},
		{"exact upper bound", until, "completed"},
		{"after upper bound", until + 1, "waiting"},
		{"previous daily occurrence", expected - int64(24*time.Hour/time.Millisecond), "waiting"},
	} {
		t.Run(test.name, func(t *testing.T) {
			out := inspectWindowFixture(t, completedHeartbeatAt("run", "target", test.at), expected, until, true)
			if out.Status != test.status || out.Status != "completed" && (out.TurnID != "" || out.Text != "") {
				t.Fatalf("boundary result: %+v; want %s", out, test.status)
			}
		})
	}
}

func TestHeartbeatEarlyToleranceDoesNotExtendShortWindowUpperBound(t *testing.T) {
	const expected, until int64 = 1_800_000_000_000, 1_800_000_000_001
	for _, test := range []struct {
		at     int64
		status string
	}{{expected - 300_000, "completed"}, {until, "completed"}, {until + 1, "waiting"}} {
		t.Run(fmt.Sprint(test.at), func(t *testing.T) {
			out := inspectWindowFixture(t, completedHeartbeatAt("run", "target", test.at), expected, until, true)
			if out.Status != test.status {
				t.Fatalf("short window: %+v; want %s", out, test.status)
			}
		})
	}
	for _, test := range []struct {
		at     int64
		status string
	}{{-1, "waiting"}, {0, "completed"}} {
		out := inspectWindowFixture(t, completedHeartbeatAt("run", "target", test.at), 1_000, 2_000, true)
		if out.Status != test.status {
			t.Fatalf("lower bound before Unix epoch: %+v; want %s", out, test.status)
		}
	}
}

func TestEarlyHeartbeatCandidatesRemainAmbiguous(t *testing.T) {
	const expected, until int64 = 1_800_000_000_000, 1_800_007_200_000
	for _, secondAt := range []int64{expected - 1, expected} {
		text := completedHeartbeatAt("early", "target", expected-133_335)
		text += completedHeartbeatAt("second", "target", secondAt)
		out := inspectWindowFixture(t, text, expected, until, true)
		if out.Status != "unknown" || !strings.Contains(out.Reason, "multiple") || out.TurnID != "" || out.Text != "" {
			t.Fatalf("ambiguous early candidate accepted: %+v", out)
		}
	}
}

func TestEarlyHeartbeatRequiresNativeIdentity(t *testing.T) {
	const expected, until int64 = 1_800_000_000_000, 1_800_007_200_000
	at := expected - 133_335
	timestamp := time.UnixMilli(at).UTC().Format(time.RFC3339Nano)
	for _, test := range []struct {
		name, text string
	}{
		{"other automation", completedHeartbeatAt("run", "different", at)},
		{"no exact turn", fixtureHeartbeat("", "target", timestamp)},
		{"missing native start", fixtureHeartbeatMessage("run", "target", timestamp) + fixtureFinal("run", "untrusted") + fixtureComplete("run")},
		{"manual trigger", strings.Replace(completedHeartbeatAt("run", "target", at), "automation_heartbeat_scheduled", "composer", 1)},
		{"conflicting triggers", completedHeartbeatAt("run", "target", at) + fixtureRecord("event_msg", map[string]any{"type": "task_started", "turn_id": "run", "turn_attribution": map[string]string{"turn_trigger": "composer"}})},
		{"different session", fixtureRecord("session_meta", map[string]string{"id": "other-thread"}) + completedHeartbeatAt("run", "target", at)},
		{"another turn final", fixtureHeartbeat("run", "target", timestamp) + fixtureFinal("other", "unrelated") + fixtureComplete("run")},
	} {
		t.Run(test.name, func(t *testing.T) {
			out := inspectWindowFixture(t, test.text, expected, until, true)
			if out.Status == "completed" || out.Text != "" {
				t.Fatalf("early tolerance accepted unrelated evidence: %+v", out)
			}
		})
	}
}

func TestCronRolloutWindowKeepsExactBounds(t *testing.T) {
	const expected, until int64 = 1_800_000_000_000, 1_800_007_200_000
	for _, test := range []struct {
		at     int64
		status string
	}{{expected - 1, "unknown"}, {expected, "completed"}, {until, "completed"}, {until + 1, "unknown"}} {
		t.Run(fmt.Sprint(test.at), func(t *testing.T) {
			text := fixtureRecord("event_msg", map[string]any{"type": "task_started", "turn_id": "run", "turn_attribution": map[string]string{"turn_trigger": "automation_cron_scheduled"}})
			text += fixtureFinal("run", "cron result") + fixtureComplete("run")
			text = strings.ReplaceAll(text, fixtureTime, time.UnixMilli(test.at).UTC().Format(time.RFC3339Nano))
			out := inspectWindowFixture(t, text, expected, until, false)
			if out.Status != test.status {
				t.Fatalf("cron boundary: %+v; want %s", out, test.status)
			}
		})
	}
}
