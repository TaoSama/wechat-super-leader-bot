package desktop

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func historyTestItem(id, kind, text string) map[string]any {
	item := map[string]any{"id": id, "type": kind}
	if kind == "userMessage" {
		item["content"] = []any{map[string]any{"type": "text", "text": text}}
	} else {
		item["text"] = text
	}
	return item
}

func historyTestTurn(id string, items ...any) map[string]any {
	return map[string]any{"turnId": id, "status": "completed", "items": append([]any{}, items...), "itemsPagination": map[string]any{"hasLoadedOldest": true}}
}

func historyTestState(canonical bool, turns ...any) map[string]any {
	state := controlState()
	state["title"] = "fixture history"
	state["threadRuntimeStatus"] = map[string]any{"type": "active"}
	state["turns"] = append([]any{}, turns...)
	if canonical {
		entries, entities := []any{}, map[string]any{}
		for i, turn := range turns {
			key := strings.Repeat("k", i+1)
			entries = append(entries, map[string]any{"value": key})
			entities[key] = turn
		}
		state["turnHistory"] = map[string]any{"kind": "canonical", "history": map[string]any{"isComplete": true, "generation": "native-generation", "islands": []any{map[string]any{"entries": entries}}, "entitiesByKey": entities}}
		state["turns"] = []any{historyTestTurn("transient", historyTestItem("not-recorded", "agentMessage", "must not export"))}
	}
	return state
}

func historyTestCanonical(state map[string]any) map[string]any {
	return state["turnHistory"].(map[string]any)["history"].(map[string]any)
}
func historyTestEntity(state map[string]any) map[string]any {
	return historyTestCanonical(state)["entitiesByKey"].(map[string]any)["k"].(map[string]any)
}

func TestDesktopHistoryProjectionOrderedPublicRecordedOnly(t *testing.T) {
	first := historyTestTurn("z-turn", historyTestItem("user", "userMessage", "question"), historyTestItem("reasoning", "reasoning", "private"), historyTestItem("assistant", "agentMessage", "answer"))
	first["turnStartedAtMs"] = float64(1000)
	second := historyTestTurn("a-turn", map[string]any{"id": "result", "type": "functionCallOutput", "output": "tool"})
	state := historyTestState(true, first, second)
	view, err := projectDesktopHistory(state, "session")
	if err != nil || !view.complete {
		t.Fatalf("projection: %v complete=%v", err, view.complete)
	}
	ids := []string{}
	for _, item := range view.items {
		ids = append(ids, item.ID)
		if item.Timestamp != "" {
			t.Fatal("fabricated turn-derived timestamp")
		}
	}
	if !reflect.DeepEqual(ids, []string{"user", "assistant", "result"}) || view.items[2].Kind != "tool" || view.items[0].TurnID != "z-turn" {
		t.Fatalf("items=%+v", view.items)
	}
	if view.session.Status != "unknown" || view.session.Loaded == nil || *view.session.Loaded || view.session.Model != "" || len(view.session.Capabilities) != 1 || view.session.Capabilities[0] != protocol.ActionRead {
		t.Fatalf("history must not create native facts=%+v", view.session)
	}
	encoded, err := json.Marshal(view.items)
	if err != nil || strings.Contains(string(encoded), "private") || strings.Contains(string(encoded), "not-recorded") {
		t.Fatalf("private projection=%s err=%v", encoded, err)
	}
}

func TestDesktopHistoryProjectionCompletenessAndShape(t *testing.T) {
	for _, tc := range []struct {
		name       string
		mutate     func(map[string]any)
		incomplete bool
		fail       bool
	}{
		{"canonical partial", func(s map[string]any) { historyTestCanonical(s)["isComplete"] = false }, true, false},
		{"missing canonical completeness", func(s map[string]any) { delete(historyTestCanonical(s), "isComplete") }, true, false},
		{"item partial", func(s map[string]any) {
			historyTestEntity(s)["itemsPagination"] = map[string]any{"hasLoadedOldest": false}
		}, true, false},
		{"evicted partial", func(s map[string]any) {
			historyTestEntity(s)["itemsPagination"] = map[string]any{"hasLoadedOldest": false, "evicted": true}
		}, true, false},
		{"missing item pagination defaults complete", func(s map[string]any) { delete(historyTestEntity(s), "itemsPagination") }, false, false},
		{"missing flag defaults complete", func(s map[string]any) { historyTestEntity(s)["itemsPagination"] = map[string]any{} }, false, false},
		{"flag bad type", func(s map[string]any) {
			historyTestEntity(s)["itemsPagination"] = map[string]any{"hasLoadedOldest": "true"}
		}, false, true},
		{"bad pagination", func(s map[string]any) { historyTestEntity(s)["itemsPagination"] = []any{} }, false, true},
		{"canonical bad complete", func(s map[string]any) { historyTestCanonical(s)["isComplete"] = "true" }, false, true},
		{"second island gap", func(s map[string]any) {
			h := historyTestCanonical(s)
			h["islands"] = append(h["islands"].([]any), map[string]any{"entries": []any{}})
		}, true, false},
		{"missing entity", func(s map[string]any) { historyTestCanonical(s)["entitiesByKey"] = map[string]any{} }, false, true},
		{"unknown history", func(s map[string]any) { s["turnHistory"].(map[string]any)["kind"] = "future" }, false, true},
		{"wrong ID", func(s map[string]any) { s["id"] = "other" }, false, true},
		{"not resumed", func(s map[string]any) { s["resumeState"] = "needs_resume" }, false, true},
		{"missing real item ID", func(s map[string]any) { delete(historyTestEntity(s)["items"].([]any)[0].(map[string]any), "id") }, false, true},
		{"bad user content", func(s map[string]any) {
			historyTestEntity(s)["items"].([]any)[0].(map[string]any)["content"] = "not native"
		}, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := historyTestState(true, historyTestTurn("turn", historyTestItem("item", "userMessage", "body")))
			tc.mutate(s)
			view, err := projectDesktopHistory(s, "session")
			if (err != nil) != tc.fail || (err == nil && view.complete == tc.incomplete) {
				t.Fatalf("complete=%v err=%v", view.complete, err)
			}
		})
	}
	legacy := historyTestState(false, historyTestTurn("turn", historyTestItem("item", "agentMessage", "body")))
	view, err := projectDesktopHistory(legacy, "session")
	if err != nil || !view.complete {
		t.Fatalf("legacy default: %v", err)
	}
	legacy["turnsPagination"] = map[string]any{"hasLoadedOldest": false}
	view, err = projectDesktopHistory(legacy, "session")
	if err != nil || view.complete {
		t.Fatalf("legacy partial: %v", err)
	}
}

func TestDesktopHistorySteeringAcceptedIdentityAndDedup(t *testing.T) {
	steering := func(id, status, serverID string) map[string]any {
		return map[string]any{"id": id, "type": "steeringUserMessage", "status": status, "serverUserMessageId": serverID, "targetTurnId": "turn", "input": []any{map[string]any{"type": "text", "text": "steered"}}, "restoreMessage": map[string]any{"secret": "private"}}
	}
	turn := historyTestTurn("turn", steering("local1", "accepted", "native1"), map[string]any{"id": "native1", "type": "steered"}, steering("local2", "pending", ""), steering("local3", "accepted", ""), steering("local4", "accepted", "native2"), historyTestItem("native2", "userMessage", "native preferred"))
	view, err := projectDesktopHistory(historyTestState(true, turn), "session")
	if err != nil || len(view.items) != 2 || view.items[0].ID != "native1" || view.items[0].Kind != "user" || view.items[1].Text != "native preferred" {
		t.Fatalf("steering=%+v err=%v", view.items, err)
	}
	view, err = projectDesktopHistory(historyTestState(true, historyTestTurn("one", historyTestItem("collision", "agentMessage", "a")), historyTestTurn("two", historyTestItem("collision", "agentMessage", "b"))), "session")
	if err == nil {
		t.Fatalf("cross-turn collision accepted: %+v", view.items)
	}
}

func TestDesktopHistoryItemTimesAndClipping(t *testing.T) {
	turn := historyTestTurn("turn", historyTestItem("assistant", "agentMessage", strings.Repeat("中", protocol.MaxHistoryTextLength)))
	turn["agentMessageCompletedAtMsById"] = map[string]any{"assistant": float64(1000)}
	view, err := projectDesktopHistory(historyTestState(false, turn), "session")
	if err != nil || !view.items[0].Truncated || view.items[0].Timestamp != "1970-01-01T00:00:01Z" || len(view.items[0].Text) > protocol.MaxHistoryTextLength {
		t.Fatalf("times/clipping: %+v err=%v", view.items, err)
	}
}
