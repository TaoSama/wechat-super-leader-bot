package appserver

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/gorilla/websocket"
)

func TestNativeMediaListsOnlyBoundedExistingThreadAttachments(t *testing.T) {
	const skippedImages = 256
	directory, err := os.MkdirTemp("/tmp", "media-rpc-")
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
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			finished <- err
			return
		}
		defer func() {
			if err := conn.Close(); err != nil {
				t.Logf("close media RPC: %v", err)
			}
		}()
		if err := conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
			finished <- err
			return
		}
		for _, method := range []string{"initialize", "initialized", "thread/read", "thread/items/list"} {
			var request steerRequest
			if err := conn.ReadJSON(&request); err != nil {
				finished <- err
				return
			}
			if request.Method != method {
				finished <- errors.New("media listing attempted unexpected RPC")
				return
			}
			var result any = map[string]any{}
			switch method {
			case "initialized":
				continue
			case "thread/read":
				if request.Params["threadId"] != "session" || request.Params["includeTurns"] != false {
					finished <- errors.New("media metadata was not exact and bounded")
					return
				}
				result = map[string]any{"thread": map[string]any{"id": "session"}}
			case "thread/items/list":
				if request.Params["threadId"] != "session" || request.Params["sortDirection"] != "desc" || request.Params["limit"] != float64(protocol.MaxHistoryLimit) {
					finished <- errors.New("media item read was not exact and bounded")
					return
				}
				result = map[string]any{"data": []any{
					map[string]any{"turnId": "new-turn", "item": map[string]any{"id": "new", "type": "agentMessage", "text": strings.Repeat("![remote](https://example.com/image.png) ", skippedImages) + "![a](/tmp/a.jpg) ![b](/tmp/b.jpg) ![c](/tmp/c.jpg) ![d](/tmp/d.jpg)"}},
					map[string]any{"turnId": "old-turn", "item": map[string]any{"id": "old", "type": "agentMessage", "text": "![old](/tmp/old.jpg)"}},
				}}
			}
			if err := conn.WriteJSON(map[string]any{"id": request.ID, "result": result}); err != nil {
				finished <- err
				return
			}
		}
		finished <- nil
	}))
	server.Listener = listener
	server.Start()
	t.Cleanup(server.Close)
	adapter := NewAppServerAdapter(socket)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	refs, generation, err := adapter.ListSessionMedia(ctx, "session", "", "", "", protocol.MaxSessionMedia)
	if err != nil || generation == "" || len(refs) != protocol.MaxSessionMedia {
		t.Fatalf("native refs %+v %q %v", refs, generation, err)
	}
	for i, ref := range refs {
		if ref.ItemID != "new" || ref.TurnID != "new-turn" || ref.Ordinal != skippedImages+i {
			t.Fatalf("did not select latest assistant %+v", ref)
		}
	}
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := adapter.ValidateMediaGeneration(ctx, "session", generation); err != nil {
		t.Fatal(err)
	}
	if err := adapter.ValidateMediaGeneration(ctx, "session", "another-owner"); err == nil {
		t.Fatal("changed generation accepted")
	}
	server.Close()
	if err := adapter.ValidateMediaGeneration(ctx, "session", generation); err == nil {
		t.Fatal("disconnected socket retained generation")
	}
}

func TestNativeMediaExpiresWhenDeadOwnerLeavesSocketFile(t *testing.T) {
	directory, err := os.MkdirTemp("/tmp", "media-owner-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(directory); err != nil {
			t.Error(err)
		}
	})
	socket := filepath.Join(directory, "owner.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	listener.SetUnlinkOnClose(false)
	t.Cleanup(func() {
		if err := os.Remove(socket); err != nil {
			t.Error(err)
		}
	})
	t.Cleanup(func() {
		if err := listener.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			t.Error(err)
		}
	})
	adapter := NewAppServerAdapter(socket)
	generation, err := adapter.mediaGeneration()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := adapter.ValidateMediaGeneration(ctx, "session", generation); err != nil {
		t.Fatal(err)
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(socket); err != nil {
		t.Fatal("fixture did not retain stale socket")
	}
	if err := adapter.ValidateMediaGeneration(ctx, "session", generation); err == nil {
		t.Fatal("dead owner socket retained media authority")
	}
}
