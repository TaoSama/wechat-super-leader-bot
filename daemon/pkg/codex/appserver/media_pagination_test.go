package appserver

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func mediaPaginationItem(id, turnID, text string) any {
	return map[string]any{"turnId": turnID, "item": map[string]any{"id": id, "type": "agentMessage", "text": text}}
}

func mediaPaginationServer(t *testing.T, turnID string, page func(steerRequest) (map[string]any, bool)) *AppServerAdapter {
	t.Helper()
	return historyTurnServer(t, func(request steerRequest) (map[string]any, bool) {
		switch request.Method {
		case "thread/read":
			if request.Params["threadId"] != "session" || request.Params["includeTurns"] != false {
				t.Error("media metadata read was not exact and bounded")
			}
			return map[string]any{"thread": map[string]any{"id": "session"}}, true
		case "thread/items/list":
			if request.Params["threadId"] != "session" || request.Params["sortDirection"] != "desc" || request.Params["limit"] != float64(protocol.MaxHistoryLimit) {
				t.Error("media page read was not exact and bounded")
			}
			if turnID != "" && request.Params["turnId"] != turnID {
				t.Error("media page did not retain native turn filter")
			}
			return page(request)
		default:
			t.Errorf("unexpected media RPC %s", request.Method)
			return nil, false
		}
	})
}

func TestNativeMediaFindsLatestReplyBeyondFirstPage(t *testing.T) {
	for _, test := range []struct {
		name, itemID, turnID string
	}{
		{name: "latest"},
		{name: "exact item", itemID: "wanted"},
		{name: "exact turn", turnID: "wanted-turn"},
		{name: "exact item and turn", itemID: "wanted", turnID: "wanted-turn"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var reads atomic.Int32
			adapter := mediaPaginationServer(t, test.turnID, func(request steerRequest) (map[string]any, bool) {
				switch reads.Add(1) {
				case 1:
					if request.Params["cursor"] != nil {
						t.Error("initial media page unexpectedly supplied a cursor")
					}
					items := make([]any, protocol.MaxHistoryLimit)
					for i := range items {
						items[i] = mediaPaginationItem(fmt.Sprintf("newer-%d", i), "newer-turn", "text without images")
					}
					if test.itemID != "" || test.turnID != "" {
						items[0] = mediaPaginationItem("newer-image", "newer-turn", "![newer](/tmp/newer.png)")
					}
					return map[string]any{"data": items, "nextCursor": "older"}, true
				case 2:
					if request.Params["cursor"] != "older" {
						t.Error("next media page lost opaque native cursor")
					}
					return map[string]any{"data": []any{
						mediaPaginationItem("wanted", "wanted-turn", "![a](/tmp/wanted.png) ![b](/tmp/second.png)"),
						mediaPaginationItem("older-image", "older-turn", "![old](/tmp/old.png)"),
					}, "nextCursor": "unneeded"}, true
				default:
					t.Error("continued paging after finding the latest matching reply")
					return nil, false
				}
			})
			refs, generation, err := adapter.ListSessionMedia(context.Background(), "session", "", test.itemID, test.turnID, protocol.MaxSessionMedia)
			if err != nil || len(refs) != 2 || generation == "" || reads.Load() != 2 {
				t.Fatalf("cross-page selection: refs=%+v generation=%q pages=%d err=%v", refs, generation, reads.Load(), err)
			}
			for i, ref := range refs {
				if ref.ItemID != "wanted" || ref.TurnID != "wanted-turn" || ref.Ordinal != i {
					t.Fatalf("lost exact selection or combined older reply: %+v", ref)
				}
			}
		})
	}
}

func TestNativeMediaConsumesEmptyPageUntilHistoryEnds(t *testing.T) {
	var reads atomic.Int32
	adapter := mediaPaginationServer(t, "", func(request steerRequest) (map[string]any, bool) {
		if reads.Add(1) == 1 {
			return map[string]any{"data": []any{}, "nextCursor": "older"}, true
		}
		if request.Params["cursor"] != "older" {
			t.Error("empty first page prevented cursor traversal")
		}
		return map[string]any{"data": []any{}, "nextCursor": nil}, true
	})
	refs, generation, err := adapter.ListSessionMedia(context.Background(), "session", "", "", "", protocol.MaxSessionMedia)
	if err != nil || len(refs) != 0 || generation == "" || reads.Load() != 2 {
		t.Fatalf("empty completed history: refs=%+v generation=%q pages=%d err=%v", refs, generation, reads.Load(), err)
	}
}

func TestNativeMediaRejectsInvalidOrRepeatedPageCursor(t *testing.T) {
	for _, test := range []struct {
		name    string
		cursors []any
	}{
		{name: "wrong type", cursors: []any{42}},
		{name: "oversized", cursors: []any{strings.Repeat("a", protocol.MaxHistoryCursorLength+1)}},
		{name: "same cursor", cursors: []any{"older", "older"}},
		{name: "cursor cycle", cursors: []any{"older", "oldest", "older"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			var reads atomic.Int32
			adapter := mediaPaginationServer(t, "", func(request steerRequest) (map[string]any, bool) {
				index := int(reads.Add(1)) - 1
				if index >= len(test.cursors) {
					t.Error("invalid native cursor was followed")
					return nil, false
				}
				return map[string]any{"data": []any{}, "nextCursor": test.cursors[index]}, true
			})
			refs, generation, err := adapter.ListSessionMedia(context.Background(), "session", "", "", "", protocol.MaxSessionMedia)
			if err == nil || err.Error() != protocol.MediaFailed || len(refs) != 0 || generation != "" || int(reads.Load()) != len(test.cursors) {
				t.Fatalf("invalid cursor: refs=%+v generation=%q pages=%d err=%v", refs, generation, reads.Load(), err)
			}
		})
	}
}

func TestNativeMediaPaginationBudgetNeverReportsIncompleteHistoryAsEmpty(t *testing.T) {
	var reads atomic.Int32
	adapter := mediaPaginationServer(t, "", func(request steerRequest) (map[string]any, bool) {
		page := reads.Add(1)
		return map[string]any{"data": []any{}, "nextCursor": strconv.Itoa(int(page))}, true
	})
	refs, generation, err := adapter.ListSessionMedia(context.Background(), "session", "", "", "", protocol.MaxSessionMedia)
	if err == nil || err.Error() != protocol.MediaUnavailable || len(refs) != 0 || generation != "" || reads.Load() != maxMediaPages {
		t.Fatalf("incomplete bounded scan: refs=%+v generation=%q pages=%d err=%v", refs, generation, reads.Load(), err)
	}
}

func TestNativeMediaNextPageFailureDoesNotBecomeEmptySuccess(t *testing.T) {
	var reads atomic.Int32
	adapter := mediaPaginationServer(t, "", func(request steerRequest) (map[string]any, bool) {
		if reads.Add(1) == 1 {
			return map[string]any{"data": []any{}, "nextCursor": "older"}, true
		}
		return nil, false
	})
	refs, generation, err := adapter.ListSessionMedia(context.Background(), "session", "", "", "", protocol.MaxSessionMedia)
	if err == nil || err.Error() != protocol.MediaUnavailable || len(refs) != 0 || generation != "" || reads.Load() != 2 {
		t.Fatalf("failed next page: refs=%+v generation=%q pages=%d err=%v", refs, generation, reads.Load(), err)
	}
}
