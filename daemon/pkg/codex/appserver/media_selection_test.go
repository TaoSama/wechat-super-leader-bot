package appserver

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestNativeMediaDefaultsToAssistantReplyAndPreservesExplicitSelection(t *testing.T) {
	user := map[string]any{"turnId": "user-turn", "item": map[string]any{
		"id": "user-item", "type": "userMessage", "content": []any{
			map[string]any{"type": "localImage", "path": "/tmp/user-input.png"},
		},
	}}
	assistant := map[string]any{"turnId": "assistant-turn", "item": map[string]any{
		"id": "assistant-item", "type": "agentMessage", "text": "![reply](/tmp/assistant-output.png)",
	}}
	items := []any{
		user,
		map[string]any{"turnId": "text-turn", "item": map[string]any{
			"id": "text-item", "type": "agentMessage", "text": "Latest reply without images.",
		}},
		assistant,
		map[string]any{"turnId": "older-turn", "item": map[string]any{
			"id": "older-item", "type": "agentMessage", "text": "![older](/tmp/older-output.png)",
		}},
	}
	assistantRef := protocol.NativeMediaReference{ItemID: "assistant-item", TurnID: "assistant-turn", Ordinal: 0, Path: "/tmp/assistant-output.png"}
	userRef := protocol.NativeMediaReference{ItemID: "user-item", TurnID: "user-turn", Ordinal: 0, Path: "/tmp/user-input.png"}
	for _, tc := range []struct {
		name   string
		items  []any
		itemID string
		turnID string
		want   []protocol.NativeMediaReference
	}{
		{name: "default skips user input and text replies", items: items, want: []protocol.NativeMediaReference{assistantRef}},
		{name: "default with only user images is empty", items: []any{user}, want: []protocol.NativeMediaReference{}},
		{name: "explicit user item", items: items, itemID: "user-item", want: []protocol.NativeMediaReference{userRef}},
		{name: "explicit user turn", items: items, turnID: "user-turn", want: []protocol.NativeMediaReference{userRef}},
		{name: "explicit user item and turn", items: items, itemID: "user-item", turnID: "user-turn", want: []protocol.NativeMediaReference{userRef}},
		{name: "explicit assistant item", items: items, itemID: "assistant-item", want: []protocol.NativeMediaReference{assistantRef}},
		{name: "mismatched item and turn is empty", items: items, itemID: "user-item", turnID: "assistant-turn", want: []protocol.NativeMediaReference{}},
		{name: "missing item never falls back", items: items, itemID: "missing", want: []protocol.NativeMediaReference{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			adapter := historyTurnServer(t, func(request steerRequest) (map[string]any, bool) {
				switch request.Method {
				case "thread/read":
					return map[string]any{"thread": map[string]any{"id": "session"}}, true
				case "thread/items/list":
					if request.Params["sortDirection"] != "desc" || request.Params["limit"] != float64(protocol.MaxHistoryLimit) {
						t.Error("media selection lost bounded newest-first history")
					}
					return map[string]any{"data": tc.items}, true
				default:
					t.Errorf("unexpected media selection RPC %s", request.Method)
					return nil, false
				}
			})
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			refs, generation, err := adapter.ListSessionMedia(ctx, "session", "", tc.itemID, tc.turnID, protocol.MaxSessionMedia)
			if err != nil || generation == "" || !reflect.DeepEqual(refs, tc.want) {
				t.Fatalf("selected=%+v want=%+v generation=%q err=%v", refs, tc.want, generation, err)
			}
		})
	}
}
