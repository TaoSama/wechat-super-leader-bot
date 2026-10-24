package client

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	mediaHarnessSession = "media-harness-session"
	mediaHarnessOwner   = "media-harness-owner"
	mediaHarnessClient  = "media-harness-client"
	mediaHarnessTimeout = 10 * time.Second
)

func TestDesktopSessionMediaReadonlyHarnessWithoutControlSocket(t *testing.T) {
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	content, digests := []any{}, []string{}
	imageMarkdown := make([]string, 0, protocol.MaxSessionMedia)
	for i := range protocol.MaxSessionMedia {
		picture := image.NewRGBA(image.Rect(0, 0, 1, 1))
		picture.SetRGBA(0, 0, color.RGBA{R: uint8(i * 80), A: 255})
		var encoded bytes.Buffer
		if err := jpeg.Encode(&encoded, picture, nil); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(directory, fmt.Sprintf("image-%d.jpg", i))
		if err := os.WriteFile(path, encoded.Bytes(), 0600); err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(encoded.Bytes())
		digests = append(digests, hex.EncodeToString(digest[:]))
		content = append(content, map[string]any{"type": "localImage", "path": path})
		imageMarkdown = append(imageMarkdown, fmt.Sprintf("![image](<%s>)", path))
	}
	// A newer user input must not replace the assistant's ordered output images.
	slices.Reverse(content)
	state := map[string]any{
		"id": mediaHarnessSession, "hostId": "local", "resumeState": "resumed", "mode": "default", "threadSource": "user",
		"threadRuntimeStatus": map[string]any{"type": "idle"},
		"turns": []any{
			map[string]any{"turnId": "media-turn", "status": "completed",
				"items": []any{map[string]any{"id": "media-item", "type": "agentMessage", "text": strings.Join(imageMarkdown, "\n")}}},
			map[string]any{"turnId": "user-turn", "status": "completed",
				"items": []any{map[string]any{"id": "user-item", "type": "userMessage", "content": content}}},
		},
	}
	t.Setenv("CODEX_APP_SERVER_SOCKET", "")
	t.Setenv("LIVE_CODEX_DESKTOP_MEDIA", "1")
	t.Setenv("LIVE_CODEX_DESKTOP_SOCKET", mediaReadonlyHarnessSocket(t, state))
	t.Setenv("LIVE_CODEX_DESKTOP_SESSION", mediaHarnessSession)
	t.Setenv("LIVE_CODEX_MEDIA_EXPECT_SHA256", strings.Join(digests, ","))
	t.Setenv("LIVE_CODEX_MEDIA_EXPECT_SOURCE", protocol.HistorySourceDesktop)
	t.Run("live acceptance", TestLiveDesktopSessionMediaReadonly)
}

func mediaReadonlyHarnessSocket(t *testing.T, state map[string]any) string {
	t.Helper()
	directory, err := os.MkdirTemp("/tmp", "media-live-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(directory); err != nil {
			t.Error(err)
		}
	})
	path := filepath.Join(directory, "desktop.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	var failureMu sync.Mutex
	var failures []error
	reportFailure := func(err error) {
		if err != nil {
			failureMu.Lock()
			failures = append(failures, err)
			failureMu.Unlock()
		}
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			connection, err := listener.Accept()
			if err != nil {
				if !errors.Is(err, net.ErrClosed) {
					reportFailure(err)
				}
				return
			}
			workers.Add(1)
			go func() {
				defer workers.Done()
				err := connection.SetDeadline(time.Now().Add(mediaHarnessTimeout))
				if err == nil {
					err = serveMediaReadonlyHarness(connection, state)
				}
				reportFailure(errors.Join(err, connection.Close()))
			}()
		}
	}()
	t.Cleanup(func() {
		if err := listener.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			t.Error(err)
		}
		<-done
		workers.Wait()
		for _, err := range failures {
			t.Error(err)
		}
	})
	return path
}

func serveMediaReadonlyHarness(connection net.Conn, state map[string]any) error {
	for {
		request, err := readDeadlineFrame(connection)
		if err != nil {
			if deadlineConnectionClosed(err) {
				return nil
			}
			return err
		}
		owner, result := mediaHarnessOwner, any(map[string]any{})
		switch request.Method {
		case "initialize":
			owner, result = mediaHarnessClient, map[string]string{"clientId": mediaHarnessClient}
		case "thread-owner-discovery":
		case "thread-follower-read-model-settings":
			result = map[string]any{"settings": map[string]string{"resumeState": "resumed", "mode": "default", "threadSource": "user"}}
		case "thread-stream-following-changed":
			err = writeDeadlineFrame(connection, map[string]any{
				"type": "broadcast", "method": "thread-stream-state-changed", "version": 11,
				"sourceClientId": mediaHarnessOwner, "targetClientIds": []string{mediaHarnessClient},
				"params": map[string]any{"conversationId": mediaHarnessSession, "hostId": "local",
					"change": map[string]any{"type": "snapshot", "revision": 1, "conversationState": state}},
			})
		default:
			return fmt.Errorf("read-only media harness received unexpected method %q", request.Method)
		}
		if request.Type == "request" && err == nil {
			err = writeDeadlineFrame(connection, map[string]any{
				"type": "response", "requestId": request.RequestID, "method": request.Method,
				"resultType": "success", "handledByClientId": owner, "result": result,
			})
		}
		if err != nil {
			if deadlineConnectionClosed(err) {
				return nil
			}
			return err
		}
	}
}
