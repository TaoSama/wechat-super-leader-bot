package desktop

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestDesktopMediaDefaultsToAssistantReplyAndPreservesExplicitSelection(t *testing.T) {
	user := historyTestTurn("user-turn", map[string]any{
		"id": "user-item", "type": "userMessage", "content": []any{
			map[string]any{"type": "localImage", "path": "/tmp/user-input.png"},
		},
	})
	turns := []any{
		historyTestTurn("older-turn", historyTestItem("older-item", "agentMessage", "![older](/tmp/older-output.png)")),
		historyTestTurn("assistant-turn", historyTestItem("assistant-item", "agentMessage", "![reply](/tmp/assistant-output.png)")),
		historyTestTurn("text-turn", historyTestItem("text-item", "agentMessage", "Latest reply without images.")),
		user,
	}
	assistantRef := protocol.NativeMediaReference{ItemID: "assistant-item", TurnID: "assistant-turn", Ordinal: 0, Path: "/tmp/assistant-output.png"}
	userRef := protocol.NativeMediaReference{ItemID: "user-item", TurnID: "user-turn", Ordinal: 0, Path: "/tmp/user-input.png"}
	for _, tc := range []struct {
		name   string
		turns  []any
		itemID string
		turnID string
		want   []protocol.NativeMediaReference
	}{
		{name: "default skips user input and text replies", turns: turns, want: []protocol.NativeMediaReference{assistantRef}},
		{name: "default with only user images is empty", turns: []any{user}, want: []protocol.NativeMediaReference{}},
		{name: "explicit user item", turns: turns, itemID: "user-item", want: []protocol.NativeMediaReference{userRef}},
		{name: "explicit user turn", turns: turns, turnID: "user-turn", want: []protocol.NativeMediaReference{userRef}},
		{name: "explicit user item and turn", turns: turns, itemID: "user-item", turnID: "user-turn", want: []protocol.NativeMediaReference{userRef}},
		{name: "explicit assistant item", turns: turns, itemID: "assistant-item", want: []protocol.NativeMediaReference{assistantRef}},
		{name: "mismatched item and turn is empty", turns: turns, itemID: "user-item", turnID: "assistant-turn", want: []protocol.NativeMediaReference{}},
		{name: "missing item never falls back", turns: turns, itemID: "missing", want: []protocol.NativeMediaReference{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state := historyTestState(true, tc.turns...)
			view, err := projectDesktopHistory(state, "session")
			if err != nil {
				t.Fatal(err)
			}
			raw, err := json.Marshal(state)
			if err != nil {
				t.Fatal(err)
			}
			reader := NewDesktopHistoryReader("unused")
			reader.entries["session"] = &desktopHistoryEntry{
				sessionID: "session", generation: "owner-generation", ctx: context.Background(), raw: raw,
				view: view, ready: true, lastUsed: time.Now(), changed: make(chan struct{}),
				cursors: map[string]desktopHistoryAnchor{}, anchorTokens: map[desktopHistoryAnchor]string{},
			}
			refs, generation, err := reader.ListSessionMedia(context.Background(), "session", "", tc.itemID, tc.turnID, protocol.MaxSessionMedia)
			if err != nil || generation != "owner-generation" || !reflect.DeepEqual(refs, tc.want) {
				t.Fatalf("selected=%+v want=%+v generation=%q err=%v", refs, tc.want, generation, err)
			}
		})
	}
}
