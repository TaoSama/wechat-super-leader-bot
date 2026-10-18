package appserver

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestHistoryPipelinesBoundedTailWithoutLoadingCompleteConversation(t *testing.T) {
	directory, err := os.MkdirTemp("/tmp", "history-rpc-")
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
	finished := make(chan error, 1)
	upgrader := websocket.Upgrader{}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			finished <- err
			return
		}
		defer func() {
			if err := connection.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
				t.Error(err)
			}
		}()
		finished <- serveHistoryPipeline(connection)
	}))
	server.Listener = listener
	server.Start()
	t.Cleanup(server.Close)
	adapter := NewAppServerAdapter(socket)
	adapter.rpcTimeout = time.Second
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	page, err := adapter.ReadHistory(ctx, "session", "older", 2)
	if err != nil {
		t.Fatal(err)
	}
	if !adapter.PagedHistoryAvailable() || len(page.Items) != 2 || page.Items[0].ID != "old" || page.Items[1].ID != "new" ||
		page.Session.ID != "session" || page.Session.Loaded == nil || !*page.Session.Loaded || page.NextCursor == nil || *page.NextCursor != "oldest" {
		t.Fatalf("invalid native bounded page: %+v", page)
	}
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func serveHistoryPipeline(connection *websocket.Conn) error {
	if err := connection.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		return err
	}
	var initialize steerRequest
	if err := connection.ReadJSON(&initialize); err != nil {
		return err
	}
	if initialize.Method != "initialize" {
		return errors.New("missing initialization")
	}
	if err := connection.WriteJSON(map[string]any{"id": initialize.ID, "result": map[string]any{}}); err != nil {
		return err
	}
	var initialized steerRequest
	if err := connection.ReadJSON(&initialized); err != nil {
		return err
	}
	if initialized.Method != "initialized" {
		return errors.New("missing initialized notification")
	}
	requests := make(map[string]steerRequest)
	// Withhold all replies until all independent reads arrive. A serial reader
	// cannot finish this fixture, regardless of CPU or network speed.
	for range 3 {
		var request steerRequest
		if err := connection.ReadJSON(&request); err != nil {
			return err
		}
		if _, duplicate := requests[request.Method]; duplicate {
			return errors.New("duplicate history RPC")
		}
		requests[request.Method] = request
	}
	metadata, ok := requests["thread/read"]
	if !ok || metadata.Params["threadId"] != "session" || metadata.Params["includeTurns"] != false {
		return errors.New("history requested full turns or wrong session")
	}
	tail, ok := requests["thread/items/list"]
	if !ok || tail.Params["limit"] != float64(2) || tail.Params["sortDirection"] != "desc" || tail.Params["cursor"] != "older" {
		return errors.New("history lost native bounded pagination")
	}
	loaded, ok := requests["thread/loaded/list"]
	if !ok {
		return errors.New("missing loaded-state read")
	}
	results := []struct {
		request steerRequest
		result  map[string]any
	}{
		{tail, map[string]any{"data": []any{
			map[string]any{"turnId": "turn", "item": map[string]any{"id": "new", "type": "agentMessage", "text": "latest"}},
			map[string]any{"turnId": "turn", "item": map[string]any{"id": "old", "type": "userMessage", "content": []any{map[string]any{"type": "text", "text": "question"}}}},
		}, "nextCursor": "oldest"}},
		{metadata, map[string]any{"thread": map[string]any{"id": "session", "status": map[string]any{"type": "idle"}}}},
		{loaded, map[string]any{"data": []any{"session"}}},
	}
	for _, result := range results {
		if err := connection.WriteJSON(map[string]any{"id": result.request.ID, "result": result.result}); err != nil {
			return err
		}
	}
	return nil
}
