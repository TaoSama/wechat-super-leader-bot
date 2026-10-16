package live_test

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/appserver"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestLiveHistoryReadonly(t *testing.T) {
	id := os.Getenv("LIVE_CODEX_HISTORY_SESSION")
	if id == "" {
		t.Skip("LIVE_CODEX_HISTORY_SESSION not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	history, err := appserver.NewAppServerAdapter(os.Getenv("CODEX_APP_SERVER_SOCKET")).ReadHistory(ctx, id, "", 30)
	if err != nil {
		t.Fatal(err)
	}
	if history.Session.ID != id {
		t.Fatal("native history identity mismatch")
	}
	encoded, err := json.Marshal(history)
	if err != nil || len(encoded) >= protocol.MaxHistoryResponseBytes || len(history.Items) > protocol.DefaultHistoryLimit {
		t.Fatal("native history violates response bounds")
	}
	if _, err := time.Parse(time.RFC3339Nano, history.FetchedAt); err != nil {
		t.Fatal("native history missing fetch timestamp")
	}
	counts := map[string]int{}
	for _, item := range history.Items {
		if !protocol.ValidHistoryIdentity(item.ID) || !protocol.ValidHistoryIdentity(item.TurnID) || len(item.Text) > protocol.MaxHistoryTextLength || !utf8.ValidString(item.Text) {
			t.Fatal("native history item violates public schema")
		}
		if item.Kind != "user" && item.Kind != "assistant" && item.Kind != "tool" && item.Kind != "system" {
			t.Fatal("native history item has unknown public kind")
		}
		counts[item.Kind]++
	}
	t.Logf("readonly native history verified: items=%d kinds=%v modelReported=%v loadedReported=%v olderPage=%v", len(history.Items), counts, history.Session.Model != "", history.Session.Loaded != nil, history.NextCursor != nil)
}
