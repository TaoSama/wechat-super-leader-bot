package automation

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

const cadenceExpectedAt int64 = 1_793_664_000_000
const cadenceNotAfter int64 = cadenceExpectedAt + 2*60*60*1000

func cadenceReaderFixture(t *testing.T, tomlRule string, databaseRule *string, text string) Reader {
	t.Helper()
	r, db := readerFixture(t, "heartbeat")
	config := "id='target'\nkind='heartbeat'\nname='test'\nprompt='inspect'\nstatus='ACTIVE'\ntarget_thread_id='thread'\nrrule=" + strconv.Quote(tomlRule) + "\n"
	if err := os.WriteFile(filepath.Join(r.Home, "automations", "target", "automation.toml"), []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	if databaseRule != nil {
		if _, err := db.Exec("alter table automations add column rrule text"); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec("update automations set rrule=? where id='target'", *databaseRule); err != nil {
			t.Fatal(err)
		}
	}
	path := filepath.Join(r.Home, "sessions", "cadence.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(fixtureRecord("session_meta", map[string]string{"id": "thread"})+text), 0600); err != nil {
		t.Fatal(err)
	}
	state := dbFixture(t, filepath.Join(r.Home, "state_5.sqlite"), "")
	if _, err := state.Exec("insert into threads values('thread',?)", path); err != nil {
		t.Fatal(err)
	}
	return r
}

func inspectCadence(t *testing.T, r Reader) Inspection {
	t.Helper()
	out, err := r.Inspect(context.Background(), "target", cadenceExpectedAt, cadenceNotAfter)
	if err != nil {
		t.Fatal(err)
	}
	if out.ExpectedAt != cadenceExpectedAt || out.NotAfter != cadenceNotAfter {
		t.Fatalf("inspection changed requested occurrence window: %+v", out)
	}
	return out
}

func TestReaderMinutelyHeartbeatDoesNotUsePreviousOccurrence(t *testing.T) {
	rule := "FREQ=MINUTELY;INTERVAL=5"
	previous := completedHeartbeatAt("previous", "target", cadenceExpectedAt-300_000)
	t.Run("previous occurrence alone", func(t *testing.T) {
		r := cadenceReaderFixture(t, rule, &rule, previous)
		out := inspectCadence(t, r)
		if out.Status != "waiting" || out.TurnID != "" || out.Text != "" {
			t.Fatalf("previous MINUTELY occurrence must not complete current window: %+v", out)
		}
	})
	t.Run("current occurrence wins without false ambiguity", func(t *testing.T) {
		text := previous + completedHeartbeatAt("current", "target", cadenceExpectedAt)
		r := cadenceReaderFixture(t, rule, &rule, text)
		out := inspectCadence(t, r)
		if out.Status != "completed" || out.TurnID != "current" || out.Text != "exact result" {
			t.Fatalf("current MINUTELY occurrence was not selected: %+v", out)
		}
	})
}

func TestReaderVerifiedSingleDailyHeartbeatAllowsBoundedEarlyEvidence(t *testing.T) {
	for _, rule := range []string{"FREQ=DAILY", "FREQ=DAILY;INTERVAL=1;BYHOUR=8;BYMINUTE=0;BYSECOND=0"} {
		for _, test := range []struct {
			lead   int64
			status string
		}{{133_335, "completed"}, {300_000, "completed"}, {300_001, "waiting"}} {
			t.Run(fmt.Sprintf("%s/%d", rule, test.lead), func(t *testing.T) {
				r := cadenceReaderFixture(t, rule, &rule, completedHeartbeatAt("run", "target", cadenceExpectedAt-test.lead))
				out := inspectCadence(t, r)
				if out.Status != test.status {
					t.Fatalf("verified DAILY early occurrence: %+v; want %s", out, test.status)
				}
				if test.status == "completed" && (out.TurnID != "run" || out.Text != "exact result") ||
					test.status != "completed" && (out.TurnID != "" || out.Text != "") {
					t.Fatalf("incorrect exact-turn evidence: %+v", out)
				}
			})
		}
	}
}

var strictHeartbeatRules = []string{
	"FREQ=MINUTELY;INTERVAL=5",
	"FREQ=HOURLY", "FREQ=SECONDLY", "FREQ=WEEKLY", "FREQ=MONTHLY", "FREQ=YEARLY",
	"FREQ=DAILY;BYHOUR=8,9", "FREQ=DAILY;BYMINUTE=0,5", "FREQ=DAILY;BYSECOND=0,30",
	"FREQ=DAILY;X-UNKNOWN=1", "FREQ=DAILY;BYSETPOS=1",
	"FREQ=DAILY;FREQ=DAILY", "FREQ=DAILY;BYHOUR=8;BYHOUR=9", "FREQ=DAILY;INTERVAL=1;INTERVAL=2",
	"FREQ=DAILY;INTERVAL=0", "FREQ=DAILY;INTERVAL=-1", "FREQ=DAILY;INTERVAL=1.5",
	"FREQ=DAILY;INTERVAL=999999999999999999999999999999999",
	"FREQ=DAILY;BYHOUR=-1", "FREQ=DAILY;BYHOUR=24", "FREQ=DAILY;BYHOUR=8.5",
	"FREQ=DAILY;BYMINUTE=60", "FREQ=DAILY;BYMINUTE=-1", "FREQ=DAILY;BYSECOND=61", "FREQ=DAILY;BYSECOND=-1",
	"FREQ=DAILY;INTERVAL=", "FREQ=DAILY;BYHOUR=", "FREQ=DAILY;", "FREQ=DAILY;;BYHOUR=8",
	"FREQ=DAILY;INVALID", "FREQ=DAILY;BYHOUR=8=9", "", "BYHOUR=8",
}

func TestReaderUnverifiedHeartbeatCadencesKeepExactLowerBound(t *testing.T) {
	for _, rule := range strictHeartbeatRules {
		t.Run(rule, func(t *testing.T) {
			for _, withCurrent := range []bool{false, true} {
				t.Run(fmt.Sprint(withCurrent), func(t *testing.T) {
					text := completedHeartbeatAt("previous", "target", cadenceExpectedAt-133_335)
					if withCurrent {
						text += completedHeartbeatAt("current", "target", cadenceExpectedAt)
					}
					r := cadenceReaderFixture(t, rule, &rule, text)
					out := inspectCadence(t, r)
					if !withCurrent && (out.Status != "waiting" || out.TurnID != "" || out.Text != "") {
						t.Fatalf("unverified cadence widened lower bound: rule=%q %+v", rule, out)
					}
					if withCurrent && (out.Status != "completed" || out.TurnID != "current" || out.Text != "exact result") {
						t.Fatalf("strict cadence lost on-time evidence: rule=%q %+v", rule, out)
					}
				})
			}
		})
	}
}

func TestReaderDailyRuleRequiresMatchingNativeDatabaseEvidence(t *testing.T) {
	minutely, equivalent, empty := "FREQ=MINUTELY;INTERVAL=5", "FREQ=DAILY;INTERVAL=1", ""
	for _, test := range []struct {
		name string
		rule *string
	}{
		{"missing database column", nil}, {"different native cadence", &minutely},
		{"equivalent but not identical native rule", &equivalent}, {"empty native rule", &empty},
	} {
		t.Run(test.name, func(t *testing.T) {
			for _, withCurrent := range []bool{false, true} {
				t.Run(fmt.Sprint(withCurrent), func(t *testing.T) {
					text := completedHeartbeatAt("previous", "target", cadenceExpectedAt-133_335)
					if withCurrent {
						text += completedHeartbeatAt("current", "target", cadenceExpectedAt)
					}
					r := cadenceReaderFixture(t, "FREQ=DAILY", test.rule, text)
					out := inspectCadence(t, r)
					if !withCurrent && (out.Status != "waiting" || out.TurnID != "" || out.Text != "") {
						t.Fatalf("missing or mismatched cadence admitted early evidence: %+v", out)
					}
					if withCurrent && (out.Status != "completed" || out.TurnID != "current" || out.Text != "exact result") {
						t.Fatalf("missing or mismatched cadence blocked on-time evidence: %+v", out)
					}
				})
			}
		})
	}
}

func TestReaderVerifiedDailyEarlyCandidatesRemainAmbiguous(t *testing.T) {
	rule := "FREQ=DAILY"
	for _, secondAt := range []int64{cadenceExpectedAt - 1, cadenceExpectedAt} {
		t.Run(fmt.Sprint(secondAt), func(t *testing.T) {
			text := completedHeartbeatAt("early", "target", cadenceExpectedAt-133_335)
			text += completedHeartbeatAt("second", "target", secondAt)
			r := cadenceReaderFixture(t, rule, &rule, text)
			out := inspectCadence(t, r)
			if out.Status != "unknown" || !strings.Contains(out.Reason, "multiple") || out.TurnID != "" || out.Text != "" {
				t.Fatalf("ambiguous verified DAILY occurrence was accepted: %+v", out)
			}
		})
	}
}

func TestSingleDailyHeartbeatRuleClassification(t *testing.T) {
	for _, rule := range []string{
		"FREQ=DAILY", "FREQ=DAILY;INTERVAL=1", "FREQ=DAILY;INTERVAL=2",
		"FREQ=DAILY;BYHOUR=0;BYMINUTE=0;BYSECOND=0",
		"FREQ=DAILY;BYHOUR=23;BYMINUTE=59;BYSECOND=59",
		"BYHOUR=8;FREQ=DAILY;BYMINUTE=0;BYSECOND=0;INTERVAL=1",
	} {
		t.Run(rule, func(t *testing.T) {
			if !singleDailyHeartbeatRule(rule) {
				t.Fatalf("single daily rule was rejected: %q", rule)
			}
		})
	}
	for _, rule := range strictHeartbeatRules {
		t.Run(rule, func(t *testing.T) {
			if singleDailyHeartbeatRule(rule) {
				t.Fatalf("unverified or multiple daily cadence was admitted: %q", rule)
			}
		})
	}
}
