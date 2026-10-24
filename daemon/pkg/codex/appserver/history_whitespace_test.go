package appserver

import (
	"context"
	"testing"
	"time"
)

func TestHistoryAdapterPreservesBodyWhitespace(t *testing.T) {
	const assistant = "    const answer = 42\n    console.log(answer)\n"
	const first = "first line  "
	const second = "    indented block\n\n"
	const whitespace = " \t\n "
	adapter := historyTurnServer(t, func(request steerRequest) (map[string]any, bool) {
		switch request.Method {
		case "thread/read":
			return map[string]any{"thread": map[string]any{"id": "session"}}, true
		case "thread/items/list":
			return map[string]any{"data": []any{
				map[string]any{"turnId": "turn", "item": map[string]any{"id": "blank", "type": "agentMessage", "text": whitespace}},
				map[string]any{"turnId": "turn", "item": map[string]any{"id": "assistant", "type": "agentMessage", "text": assistant}},
				map[string]any{"turnId": "turn", "item": map[string]any{"id": "user", "type": "userMessage", "content": []any{
					map[string]any{"type": "text", "text": first},
					map[string]any{"type": "inputText", "text": second},
					map[string]any{"type": "text", "text": whitespace},
				}}},
			}}, true
		case "thread/turns/list":
			return map[string]any{"data": []any{map[string]any{"id": "turn", "status": "completed"}}}, true
		default:
			t.Errorf("unexpected history RPC %s", request.Method)
			return nil, false
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	history, err := adapter.ReadHistory(ctx, "session", "", 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(history.Items) != 3 || history.Truncated {
		t.Fatalf("invalid history page: items=%d truncated=%v", len(history.Items), history.Truncated)
	}
	for i, want := range []string{first + "\n" + second + "\n" + whitespace, assistant, whitespace} {
		if item := history.Items[i]; item.Text != want || item.Truncated {
			t.Errorf("item %s body=%q want=%q truncated=%v", item.ID, item.Text, want, item.Truncated)
		}
	}
}
