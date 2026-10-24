package client

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/appserver"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/gorilla/websocket"
)

const mediaBindingTestTimeout = 20 * time.Second

func mediaBindingNativeRPC(t *testing.T, imagePath string) (string, *atomic.Int32, <-chan error) {
	t.Helper()
	directory, err := os.MkdirTemp("/tmp", "media-binding-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Remove(directory); err != nil {
			t.Error(err)
		}
	})
	socketPath := filepath.Join(directory, "app.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	pages := &atomic.Int32{}
	failures := make(chan error, 16)
	report := func(err error) {
		select {
		case failures <- err:
		default:
			t.Errorf("additional media RPC fixture error: %v", err)
		}
	}
	upgrader := websocket.Upgrader{}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			report(err)
			return
		}
		defer func() {
			if err := conn.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
				report(err)
			}
		}()
		if err := conn.SetReadDeadline(time.Now().Add(mediaBindingTestTimeout)); err != nil {
			report(err)
			return
		}
		for {
			var request struct {
				ID     uint64         `json:"id"`
				Method string         `json:"method"`
				Params map[string]any `json:"params"`
			}
			if err := conn.ReadJSON(&request); err != nil {
				if !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) && !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
					report(err)
				}
				return
			}
			var result any = map[string]any{}
			switch request.Method {
			case "initialize":
			case "initialized":
				continue
			case "thread/loaded/list", "thread/list":
				result = map[string]any{"data": []any{}, "nextCursor": nil}
			case "thread/read":
				if request.Params["includeTurns"] != false {
					report(errors.New("media metadata query included native turns"))
					return
				}
				result = map[string]any{"thread": map[string]any{"id": request.Params["threadId"]}}
			case "thread/items/list":
				if request.Params["limit"] != float64(protocol.MaxHistoryLimit) || request.Params["sortDirection"] != "desc" {
					report(errors.New("media query lost its native page bound"))
					return
				}
				pages.Add(1)
				text := "This assistant response has no image."
				if request.Params["threadId"] == "image-session" {
					text = "![generated](" + imagePath + ")"
				}
				result = map[string]any{"data": []any{map[string]any{"turnId": "turn", "item": map[string]any{"id": "item", "type": "agentMessage", "text": text}}}}
			default:
				report(fmt.Errorf("media test attempted unexpected native RPC %s", request.Method))
				return
			}
			if err := conn.WriteJSON(map[string]any{"id": request.ID, "result": result}); err != nil {
				report(err)
				return
			}
		}
	}))
	server.Listener = listener
	server.Start()
	t.Cleanup(server.Close)
	return socketPath, pages, failures
}

func TestEmptyMediaListsPreserveCapacityViaControllerAndNativeRPC(t *testing.T) {
	path := mediaFixturePath(t)
	var imageBytes bytes.Buffer
	if err := png.Encode(&imageBytes, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	want := imageBytes.Bytes()
	if err := os.WriteFile(path, want, 0600); err != nil {
		t.Fatal(err)
	}
	socketPath, nativePages, rpcFailures := mediaBindingNativeRPC(t, path)
	done := make(chan error, 1)
	ready := make(chan *Daemon, 1)
	upgrader := websocket.Upgrader{}
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			done <- err
			return
		}
		defer func() {
			if err := conn.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
				t.Logf("close media controller fixture: %v", err)
			}
		}()
		if err := conn.SetReadDeadline(time.Now().Add(mediaBindingTestTimeout)); err != nil {
			done <- err
			return
		}
		var hello protocol.DaemonHelloMessage
		if err := conn.ReadJSON(&hello); err != nil {
			done <- err
			return
		}
		if hello.Type != "hello" {
			done <- errors.New("media connection did not send hello")
			return
		}
		daemon := <-ready
		list := func(sessionID, requestID string) (protocol.DaemonMediaListMessage, error) {
			request := protocol.ListMediaMessage{Type: "list_media", RequestID: requestID, NodeID: "node", SessionID: sessionID}
			var response protocol.DaemonMediaListMessage
			if err := conn.WriteJSON(request); err != nil {
				return response, err
			}
			if err := readMediaWire(conn, "media_list", &response); err != nil {
				return response, err
			}
			if response.RequestID != request.RequestID || response.SessionID != sessionID {
				return response, errors.New("media listing lost request identity")
			}
			return response, nil
		}
		listEmpty := func(requestID string) error {
			response, err := list("text-session", requestID)
			if err != nil {
				return err
			}
			if response.Error != "" || len(response.Media) != 0 || !protocol.ValidMediaToken(response.MediaContext) || response.Source != protocol.HistorySourceControl {
				return fmt.Errorf("invalid empty media listing: %+v", response)
			}
			return nil
		}
		for i := range maxMediaContexts {
			if err := listEmpty(fmt.Sprintf("empty-%d", i)); err != nil {
				done <- err
				return
			}
		}
		for i := range maxMediaContexts {
			response, err := list("image-session", fmt.Sprintf("image-%d", i))
			if err != nil {
				done <- err
				return
			}
			if response.Error != "" || len(response.Media) != 1 || !protocol.ValidMediaToken(response.MediaContext) {
				done <- fmt.Errorf("image listing %d after %d empty lists: %+v", i, maxMediaContexts, response)
				return
			}
			if i == 0 {
				request := mediaReadRequest(response)
				request.SessionID = "image-session"
				if err := conn.WriteJSON(request); err != nil {
					done <- err
					return
				}
				var chunk protocol.DaemonMediaChunkMessage
				if err := readMediaWire(conn, "media_chunk", &chunk); err != nil {
					done <- err
					return
				}
				if chunk.Error != "" || !chunk.EOF || chunk.SHA256 != response.Media[0].SHA256 || chunk.MIME != "image/png" || !bytes.Equal(chunk.Data, want) {
					done <- errors.New("image read after empty lists did not preserve PNG bytes and metadata")
					return
				}
			}
		}
		response, err := list("image-session", "image-overflow")
		if err != nil {
			done <- err
			return
		}
		if response.Error != protocol.MediaBusy || response.MediaContext != "" || len(response.Media) != 0 {
			done <- fmt.Errorf("real media bindings exceeded capacity: %+v", response)
			return
		}
		if err := listEmpty("empty-at-capacity"); err != nil {
			done <- err
			return
		}
		daemon.mediaState.mu.Lock()
		retained, unreadable := len(daemon.mediaState.bindings), 0
		for _, binding := range daemon.mediaState.bindings {
			if len(binding.files) == 0 {
				unreadable++
			}
		}
		daemon.mediaState.mu.Unlock()
		if retained != maxMediaContexts || unreadable != 0 {
			done <- fmt.Errorf("retained media bindings=%d unreadable=%d", retained, unreadable)
			return
		}
		done <- nil
	}))
	defer controller.Close()
	daemon := NewDaemon(&config.Config{NodeID: "node", NodeToken: "fixture", ControllerURL: "ws" + strings.TrimPrefix(controller.URL, "http"), HeartbeatInterval: time.Hour}, appserver.NewAppServerAdapter(socketPath))
	ready <- daemon
	ctx, cancel := context.WithTimeout(context.Background(), mediaBindingTestTimeout)
	defer cancel()
	exited := make(chan error, 1)
	go func() { exited <- daemon.runOnce(ctx) }()
	select {
	case err := <-done:
		if err != nil {
			cancel()
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	select {
	case <-exited:
	case <-ctx.Done():
		t.Fatal("media connection cleanup blocked")
	}
	select {
	case err := <-rpcFailures:
		t.Fatal(err)
	default:
	}
	if nativePages.Load() != 2*maxMediaContexts+2 {
		t.Fatalf("unexpected native media page count: %d", nativePages.Load())
	}
	t.Logf("controller WS + native RPC: empty_lists=%d real_bindings=%d unreadable_bindings=0 native_pages=%d exact_png_read=true overflow=%q empty_at_capacity=success", maxMediaContexts, maxMediaContexts, nativePages.Load(), protocol.MediaBusy)
}
