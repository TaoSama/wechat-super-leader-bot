package appserver

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/gorilla/websocket"
)

func historyTurnServer(t *testing.T, result func(steerRequest) (map[string]any, bool)) *AppServerAdapter {
	t.Helper()
	directory, err := os.MkdirTemp("/tmp", "history-turns-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(directory); err != nil {
			t.Error(err)
		}
	})
	socket := filepath.Join(directory, "app.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	upgrader := websocket.Upgrader{}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer func() {
			if err := connection.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
				t.Error(err)
			}
		}()
		for {
			var request steerRequest
			if err := connection.ReadJSON(&request); err != nil {
				return
			}
			if request.Method == "initialized" {
				continue
			}
			response, ok := map[string]any{}, true
			if request.Method != "initialize" {
				response, ok = result(request)
			}
			message := map[string]any{"id": request.ID, "result": response}
			if !ok {
				delete(message, "result")
				message["error"] = map[string]any{"code": -32601, "message": "unsupported"}
			}
			if err := connection.WriteJSON(message); err != nil {
				return
			}
		}
	}))
	server.Listener = listener
	server.Start()
	t.Cleanup(server.Close)
	return NewAppServerAdapter(socket)
}

func TestHistoryTurnMetadataProgressivelyCompletesOlderPagesWithoutReadingItems(t *testing.T) {
	var itemReads, metadataReads atomic.Int32
	var active atomic.Bool
	adapter := historyTurnServer(t, func(request steerRequest) (map[string]any, bool) {
		switch request.Method {
		case "thread/read":
			return map[string]any{"thread": map[string]any{"id": "session"}}, true
		case "thread/items/list":
			turn := "old"
			if itemReads.Add(1) > 1 {
				turn = "latest"
			}
			return map[string]any{"data": []any{map[string]any{"turnId": turn, "item": map[string]any{"id": "item", "type": "agentMessage", "text": "answer"}}}}, true
		case "thread/turns/list":
			metadataReads.Add(1)
			if request.Params["itemsView"] != "notLoaded" || request.Params["limit"] != float64(historyTurnPageLimit) {
				t.Error("metadata read requested item bodies or unbounded history")
			}
			index := 0
			if raw, ok := request.Params["cursor"].(string); ok {
				var err error
				index, err = strconv.Atoi(raw)
				if err != nil {
					t.Error(err)
				}
			}
			id, status := "intermediate", "completed"
			if index == 0 {
				id = "latest"
				if active.Load() {
					status = "inProgress"
				}
			}
			if index == 5 {
				id = "old"
			}
			page := map[string]any{"data": []any{map[string]any{"id": id, "status": status, "items": []any{}}}}
			if index < 5 {
				page["nextCursor"] = strconv.Itoa(index + 1)
			}
			return page, true
		default:
			t.Errorf("unexpected history RPC %s", request.Method)
			return nil, false
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	first, err := adapter.ReadHistory(ctx, "session", "", 1)
	if err != nil || len(first.Items) != 1 || first.Items[0].TurnStatus != "" || metadataReads.Load() != historyTurnPagesPerRead {
		t.Fatalf("first bounded page: %v, reads=%d", err, metadataReads.Load())
	}
	second, err := adapter.ReadHistory(ctx, "session", "", 1)
	if err != nil || second.TurnStatuses["old"] != "completed" || second.Items[0].TurnStatus != "completed" {
		t.Fatalf("background metadata progress was lost: %v, statuses=%v", err, second.TurnStatuses)
	}
	active.Store(true)
	entry := adapter.turnCache("session")
	entry.mu.Lock()
	entry.latestAt = time.Time{}
	entry.mu.Unlock()
	third, err := adapter.ReadHistory(ctx, "session", "", 1)
	if err != nil || third.Items[0].TurnStatus != "inProgress" || third.TurnStatuses["old"] != "completed" {
		t.Fatalf("stale completed cache overrode live turn metadata: %v", err)
	}
}

func TestHistoryRemainsReadableWhenTurnMetadataUnsupported(t *testing.T) {
	adapter := historyTurnServer(t, func(request steerRequest) (map[string]any, bool) {
		switch request.Method {
		case "thread/read":
			return map[string]any{"thread": map[string]any{"id": "session"}}, true
		case "thread/items/list":
			return map[string]any{"data": []any{map[string]any{"turnId": "turn", "item": map[string]any{"id": "item", "type": "agentMessage", "text": "answer"}}}}, true
		case "thread/turns/list":
			return nil, false
		default:
			t.Errorf("unexpected RPC %s", request.Method)
			return nil, false
		}
	})
	history, err := adapter.ReadHistory(context.Background(), "session", "", 1)
	if err != nil || len(history.Items) != 1 || history.Items[0].Text != "answer" || history.Items[0].TurnStatus != "" || len(history.TurnStatuses) != 0 {
		t.Fatalf("optional status failure hid valid item history: %v", err)
	}
}

func TestHistoryTurnCachesAndMetadataStayBounded(t *testing.T) {
	adapter := NewAppServerAdapter("")
	for i := 0; i < historyTurnCacheLimit+5; i++ {
		adapter.turnCache(fmt.Sprintf("session-%d", i))
	}
	if len(adapter.historyTurns) != historyTurnCacheLimit {
		t.Fatal("session metadata cache is unbounded")
	}
	entry := adapter.turnCache("session")
	entry.wanted["wanted"] = true
	for i := 0; i < historyTurnStatusLimit+10; i++ {
		entry.remember(map[string]any{"data": []any{map[string]any{"id": fmt.Sprintf("turn-%d", i), "status": "completed"}}})
	}
	entry.remember(map[string]any{"data": []any{map[string]any{"id": "wanted", "status": "inProgress"}, map[string]any{"id": "bad", "status": "done"}}})
	if len(entry.statuses) != historyTurnStatusLimit || entry.statuses["wanted"] != "inProgress" || entry.statuses["bad"] != "" {
		t.Fatal("turn metadata exceeded bounds or discarded a requested turn")
	}
	history := protocol.SessionHistory{Items: []protocol.HistoryItem{{TurnID: "wanted"}}}
	entry.apply(&history)
	if len(history.TurnStatuses) != historyTurnStatusLimit || history.Items[0].TurnStatus != "inProgress" {
		t.Fatal("bounded status map was not applied to exact turn")
	}
}

func TestHistoryTurnMetadataDoesNotConsumeAnAlmostExpiredItemRead(t *testing.T) {
	var statusReads atomic.Int32
	adapter := historyTurnServer(t, func(request steerRequest) (map[string]any, bool) {
		switch request.Method {
		case "thread/read":
			return map[string]any{"thread": map[string]any{"id": "session"}}, true
		case "thread/items/list":
			return map[string]any{"data": []any{map[string]any{"turnId": "turn", "item": map[string]any{"id": "item", "type": "agentMessage", "text": "answer"}}}}, true
		case "thread/turns/list":
			statusReads.Add(1)
			return nil, false
		default:
			t.Errorf("unexpected RPC %s", request.Method)
			return nil, false
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), historyTurnMetadataTimeout/2)
	defer cancel()
	history, err := adapter.ReadHistory(ctx, "session", "", 1)
	if err != nil || len(history.Items) != 1 || statusReads.Load() != 0 {
		t.Fatalf("optional metadata consumed a nearly expired read: %v", err)
	}
}
