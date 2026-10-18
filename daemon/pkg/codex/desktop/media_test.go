package desktop

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestDesktopMediaUsesLatestRecordedAssistantAndPinsGeneration(t *testing.T) {
	state := historyTestState(true,
		historyTestTurn("old-turn", historyTestItem("old", "agentMessage", "![old](/tmp/old.png)")),
		historyTestTurn("new-turn", historyTestItem("new", "agentMessage", "![a](/tmp/a.jpg) ![b](/tmp/b.jpg) ![c](/tmp/c.jpg) ![d](/tmp/d.jpg)")))
	view, err := projectDesktopHistory(state, "session")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	reader := NewDesktopHistoryReader("unused")
	entry := &desktopHistoryEntry{sessionID: "session", generation: "owner-generation", ctx: context.Background(), raw: raw, view: view, ready: true, lastUsed: time.Now(), changed: make(chan struct{}), cursors: map[string]desktopHistoryAnchor{}, anchorTokens: map[desktopHistoryAnchor]string{}}
	reader.entries["session"] = entry
	refs, generation, err := reader.ListSessionMedia(context.Background(), "session", "", "", "", protocol.MaxSessionMedia)
	if err != nil || len(refs) != 3 || generation != "owner-generation" {
		t.Fatalf("list media %+v %q %v", refs, generation, err)
	}
	for i, ref := range refs {
		if ref.ItemID != "new" || ref.TurnID != "new-turn" || ref.Ordinal != i {
			t.Fatalf("wrong newest selection %+v", ref)
		}
	}
	newTurn := historyTestCanonical(state)["entitiesByKey"].(map[string]any)["kk"].(map[string]any)
	newTurn["items"] = []any{historyTestItem("new", "agentMessage", "![only](/tmp/only.jpg)")}
	raw, err = json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	entry.raw = raw
	refs, _, err = reader.ListSessionMedia(context.Background(), "session", generation, "", "", protocol.MaxSessionMedia)
	if err != nil || len(refs) != 1 || refs[0].ItemID != "new" {
		t.Fatalf("filled newest image with older attachments: %+v %v", refs, err)
	}
	if err := reader.ValidateMediaGeneration(context.Background(), "session", generation); err != nil {
		t.Fatal(err)
	}
	if err := reader.ValidateMediaGeneration(context.Background(), "other", generation); err == nil {
		t.Fatal("cross-session generation accepted")
	}
	entry.generation = "changed"
	if err := reader.ValidateMediaGeneration(context.Background(), "session", generation); err == nil {
		t.Fatal("changed owner accepted")
	}
	entry.generation = generation
	entry.err = historyError(protocol.HistoryContextExpired)
	if err := reader.ValidateMediaGeneration(context.Background(), "session", generation); err == nil {
		t.Fatal("disconnected owner accepted")
	}
}
