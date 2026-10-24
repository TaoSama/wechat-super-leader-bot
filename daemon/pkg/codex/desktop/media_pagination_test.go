package desktop

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestDesktopMediaFindsImageBeforeMoreThanOneHistoryPage(t *testing.T) {
	newerItems := make([]any, protocol.MaxHistoryLimit+1)
	for i := range newerItems {
		newerItems[i] = historyTestItem(fmt.Sprintf("newer-%d", i), "agentMessage", "text without an image")
	}
	state := historyTestState(true,
		historyTestTurn("older-turn", historyTestItem("older", "agentMessage", "![old](/tmp/older.png)")),
		historyTestTurn("wanted-turn", historyTestItem("wanted", "agentMessage", "![image](/tmp/wanted.png)")),
		historyTestTurn("newer-turn", newerItems...))
	view, err := projectDesktopHistory(state, "session")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	reader := NewDesktopHistoryReader("unused")
	reader.entries["session"] = &desktopHistoryEntry{sessionID: "session", generation: "generation", ctx: context.Background(), raw: raw, view: view,
		ready: true, lastUsed: time.Now(), changed: make(chan struct{}), cursors: map[string]desktopHistoryAnchor{}, anchorTokens: map[desktopHistoryAnchor]string{}}
	for _, test := range []struct {
		name, itemID, turnID, want string
	}{
		{name: "latest image", want: "wanted"},
		{name: "exact older item", itemID: "older", want: "older"},
		{name: "exact older turn", turnID: "older-turn", want: "older"},
		{name: "exact pair", itemID: "older", turnID: "older-turn", want: "older"},
	} {
		t.Run(test.name, func(t *testing.T) {
			refs, generation, err := reader.ListSessionMedia(context.Background(), "session", "", test.itemID, test.turnID, protocol.MaxSessionMedia)
			if err != nil || generation != "generation" || len(refs) != 1 || refs[0].ItemID != test.want {
				t.Fatalf("complete recorded media: refs=%+v generation=%q err=%v", refs, generation, err)
			}
		})
	}
}
