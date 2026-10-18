package client

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/gorilla/websocket"
)

func automationTransportFixture(t *testing.T, kind string) string {
	t.Helper()
	home := t.TempDir()
	for _, dir := range []string{"automations/daily", "sqlite", "sessions"} {
		if err := os.MkdirAll(filepath.Join(home, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	config := fmt.Sprintf("id='daily'\nkind='%s'\nname='Daily'\nstatus='ACTIVE'\nprompt='check'\nrrule='FREQ=DAILY'\n", kind)
	target := ""
	if kind == "heartbeat" {
		target = "thread"
		config += "target_thread_id='thread'\n"
	}
	if err := os.WriteFile(filepath.Join(home, "automations/daily/automation.toml"), []byte(config), 0600); err != nil {
		t.Fatal(err)
	}
	makeDB := func(path, ddl string, values ...any) {
		t.Helper()
		db, err := sql.Open("sqlite", path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = db.Exec(ddl, values...); err != nil {
			t.Fatal(err)
		}
		if err = db.Close(); err != nil {
			t.Fatal(err)
		}
	}
	makeDB(filepath.Join(home, "sqlite/codex-dev.db"), `create table automations(id text primary key,kind text,target_thread_id text,last_run_at integer,next_run_at integer);create table automation_runs(thread_id text primary key,automation_id text,created_at integer);`)
	db, err := sql.Open("sqlite", filepath.Join(home, "sqlite/codex-dev.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("insert into automations values('daily',?,?,1000,2000)", kind, target); err != nil {
		t.Fatal(err)
	}
	if kind == "cron" {
		if _, err = db.Exec("insert into automation_runs values('thread','daily',1500)"); err != nil {
			t.Fatal(err)
		}
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, "sessions/run.jsonl")
	makeDB(filepath.Join(home, "state_5.sqlite"), "create table threads(id text primary key,rollout_path text);insert into threads values('thread',?);", path)
	records := []map[string]any{{"type": "session_meta", "payload": map[string]string{"id": "thread"}}}
	if kind == "heartbeat" {
		records = append(records, map[string]any{"type": "event_msg", "payload": map[string]any{"type": "task_started", "turn_id": "turn", "turn_attribution": map[string]string{"turn_trigger": "automation_heartbeat_scheduled"}}})
		records = append(records, map[string]any{"type": "response_item", "payload": map[string]any{"type": "message", "role": "user", "content": []any{map[string]string{"text": "<heartbeat><automation_id>daily</automation_id><current_time_iso>1970-01-01T00:00:01.500Z</current_time_iso></heartbeat>"}}, "internal_chat_message_metadata_passthrough": map[string]string{"turn_id": "turn"}}})
	} else {
		records = append(records, map[string]any{"timestamp": "1970-01-01T00:00:01.500Z", "type": "event_msg", "payload": map[string]any{"type": "task_started", "turn_id": "turn", "turn_attribution": map[string]string{"turn_trigger": "automation_scheduled"}}})
	}
	records = append(records, map[string]any{"type": "response_item", "payload": map[string]any{"type": "message", "role": "assistant", "phase": "final_answer", "content": []any{map[string]string{"text": "exact result"}}, "internal_chat_message_metadata_passthrough": map[string]string{"turn_id": "turn"}}}, map[string]any{"type": "event_msg", "payload": map[string]string{"type": "task_complete", "turn_id": "turn"}})
	var data []byte
	for _, record := range records {
		line, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		data = append(append(data, line...), '\n')
	}
	if err = os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return home
}
func TestNativeAutomationAuthenticatedWebsocketRoundTrip(t *testing.T) {
	for _, kind := range []string{"heartbeat", "cron"} {
		t.Run(kind, func(t *testing.T) {
			home := automationTransportFixture(t, kind)
			result := make(chan error, 1)
			upgrader := websocket.Upgrader{}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer fixture-token" {
					result <- errors.New("missing auth")
					w.WriteHeader(401)
					return
				}
				conn, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					result <- err
					return
				}
				defer conn.Close()
				if err = conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
					result <- err
					return
				}
				var hello map[string]any
				if err = conn.ReadJSON(&hello); err != nil {
					result <- err
					return
				}
				for _, req := range []automationRequest{{Type: "list_automations", RequestID: "list", NodeID: "node"}, {Type: "inspect_automation", RequestID: "inspect", NodeID: "node", AutomationID: "daily", ExpectedAt: 1000, NotAfter: 2000}} {
					if err = conn.WriteJSON(req); err != nil {
						result <- err
						return
					}
					for {
						var res automationResponse
						if err = conn.ReadJSON(&res); err != nil {
							result <- err
							return
						}
						if res.Type != "automation_response" {
							continue
						}
						if res.Error != "" {
							result <- fmt.Errorf("read error: %s", res.Error)
							return
						}
						if req.Type == "list_automations" && (res.Automations == nil || len(*res.Automations) != 1) {
							result <- errors.New("missing config")
							return
						}
						if req.Type == "inspect_automation" && (res.Inspection == nil || res.Inspection.Status != "completed" || res.Inspection.SessionID != "thread" || res.Inspection.TurnID != "turn" || res.Inspection.Text != "exact result") {
							result <- fmt.Errorf("wrong evidence: %+v", res.Inspection)
							return
						}
						break
					}
				}
				result <- nil
			}))
			defer server.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
			defer cancel()
			d := NewDaemon(&config.Config{NodeID: "node", NodeToken: "fixture-token", CodexHome: home, ControllerURL: "ws" + strings.TrimPrefix(server.URL, "http"), HeartbeatInterval: time.Second}, &historyFixture{})
			done := make(chan error, 1)
			go func() { done <- d.runOnce(ctx) }()
			select {
			case err := <-result:
				if err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal("transport did not finish")
			}
			cancel()
			<-done
			if len(d.outbox) != 0 || len(d.dedupeCache) != 0 || len(d.inFlight) != 0 {
				t.Fatal("monitor read created command receipt")
			}
		})
	}
}
