package automation

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func dbFixture(t *testing.T, path, script string) *sql.DB {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(script); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	return db
}
func readerFixture(t *testing.T, kind string) (Reader, *sql.DB) {
	t.Helper()
	home := t.TempDir()
	dir := filepath.Join(home, "automations", "target")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	config := fmt.Sprintf("id='target'\nkind='%s'\nname='test'\nprompt='inspect'\nstatus='ACTIVE'\nrrule='FREQ=DAILY'\n", kind)
	target := ""
	if kind == "heartbeat" {
		target = "thread"
		config += "target_thread_id='thread'\n"
	}
	if err := os.WriteFile(filepath.Join(dir, "automation.toml"), []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	db := dbFixture(t, filepath.Join(home, "sqlite", "codex-dev.db"), `create table automations(id text primary key,kind text,target_thread_id text,last_run_at integer,next_run_at integer);create table automation_runs(thread_id text primary key,automation_id text,created_at integer);`)
	if _, err := db.Exec("insert into automations values('target',?,?,100,200)", kind, target); err != nil {
		t.Fatal(err)
	}
	dbFixture(t, filepath.Join(home, "state_5.sqlite"), `create table threads(id text primary key,rollout_path text);`)
	return Reader{Home: home}, db
}
func TestListReadsNativeConfigAndDatabaseWithoutMutation(t *testing.T) {
	r, _ := readerFixture(t, "heartbeat")
	before, err := os.Stat(filepath.Join(r.Home, "sqlite", "codex-dev.db"))
	if err != nil {
		t.Fatal(err)
	}
	configs, err := r.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(configs) != 1 || configs[0].TargetSessionID != "thread" || *configs[0].LastRunAt != 100 {
		t.Fatalf("bad native config: %+v", configs)
	}
	db, err := r.database(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec("delete from automations"); err == nil {
		t.Fatal("readonly database accepted mutation")
	}
	after, err := os.Stat(filepath.Join(r.Home, "sqlite", "codex-dev.db"))
	if err != nil {
		t.Fatal(err)
	}
	if after.ModTime() != before.ModTime() {
		t.Fatal("discovery changed database")
	}
}
func TestConfigurationMismatchAndMissingRolloutRemainUnknown(t *testing.T) {
	r, db := readerFixture(t, "heartbeat")
	if _, err := db.Exec("update automations set target_thread_id='different'"); err != nil {
		t.Fatal(err)
	}
	out, err := r.Inspect(context.Background(), "target", 1000, 2000)
	if err != nil || out.Status != "unknown" || out.Reason != "automation_config_database_mismatch" {
		t.Fatalf("mismatch %+v %v", out, err)
	}
	if _, err := db.Exec("update automations set target_thread_id='thread'"); err != nil {
		t.Fatal(err)
	}
	out, err = r.Inspect(context.Background(), "target", 1000, 2000)
	if err != nil || out.Status != "unknown" || out.Reason != "automation_thread_unavailable" {
		t.Fatalf("missing thread %+v %v", out, err)
	}
}
func TestCronRunMappingRejectsAmbiguityAndScanOverflow(t *testing.T) {
	r, db := readerFixture(t, "cron")
	out, err := r.Inspect(context.Background(), "target", 1000, 2000)
	if err != nil || out.Status != "waiting" {
		t.Fatalf("absent %+v %v", out, err)
	}
	if _, err = db.Exec("insert into automation_runs values('a','target',1500),('b','target',1600)"); err != nil {
		t.Fatal(err)
	}
	out, err = r.Inspect(context.Background(), "target", 1000, 2000)
	if err != nil || out.Status != "unknown" || out.Reason != "ambiguous_run" {
		t.Fatalf("ambiguous %+v %v", out, err)
	}
	for i := 0; i < 513; i++ {
		if _, err = db.Exec("insert into automation_runs values(?, 'other', 500)", fmt.Sprintf("run-%d", i)); err != nil {
			t.Fatal(err)
		}
	}
	out, err = r.Inspect(context.Background(), "target", 1000, 2000)
	if err != nil || out.Status != "unknown" || out.Reason != "automation_run_scan_limit" {
		t.Fatalf("overflow %+v %v", out, err)
	}
}
func TestInspectionRejectsBadWindowsAndUnsupportedSchema(t *testing.T) {
	r, db := readerFixture(t, "heartbeat")
	for _, id := range []string{"../target", "a'b", ""} {
		if _, err := r.Inspect(context.Background(), id, 1000, 2000); err == nil {
			t.Fatalf("bad id accepted %q", id)
		}
	}
	if _, err := db.Exec("alter table automations rename column target_thread_id to unsupported"); err != nil {
		t.Fatal(err)
	}
	out, err := r.Inspect(context.Background(), "target", 1000, 2000)
	if err != nil || out.Status != "unknown" || out.Reason != "automation_schema_unsupported" {
		t.Fatalf("schema %+v %v", out, err)
	}
}
func TestConfigSizeLimitIsExplicit(t *testing.T) {
	r, _ := readerFixture(t, "heartbeat")
	if err := os.WriteFile(filepath.Join(r.Home, "automations", "target", "automation.toml"), []byte(strings.Repeat("x", maxConfigBytes+1)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := r.List(context.Background()); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("expected explicit size error, got %v", err)
	}
}
func TestNativeAutomationLiveReadOnly(t *testing.T) {
	if os.Getenv("SUPER_LEADER_NATIVE_AUTOMATION_LIVE") != "1" {
		t.Skip("requires explicit live read-only opt-in")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	r := Reader{Home: filepath.Join(home, ".codex")}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	configs, err := r.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("native configs=%d", len(configs))
	at := time.Date(2026, 10, 18, 4, 0, 0, 0, time.UTC).UnixMilli()
	out, err := r.Inspect(ctx, "dotfiles", at, at+int64(30*time.Minute/time.Millisecond))
	if err != nil {
		t.Fatal(err)
	}
	if out.Status != "completed" || out.TurnID == "" || out.Text == "" {
		t.Fatalf("native evidence status=%s reason=%s", out.Status, out.Reason)
	}
	t.Logf("native evidence status=%s session=%s turn=%s resultBytes=%d sources=%d", out.Status, out.SessionID, out.TurnID, len(out.Text), len(out.Sources))
}

func TestEmptyNativeAutomationInventoryAndMissingConfigMismatch(t *testing.T) {
	r, db := readerFixture(t, "heartbeat")
	if _, err := db.Exec("delete from automations"); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(r.Home, "automations")); err != nil {
		t.Fatal(err)
	}
	configs, err := r.List(context.Background())
	if err != nil || len(configs) != 0 {
		t.Fatalf("empty inventory: %+v %v", configs, err)
	}
	if _, err := db.Exec("insert into automations values('target','heartbeat','thread',100,200)"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.List(context.Background()); err == nil {
		t.Fatal("database-only automation was silently omitted")
	}
}
