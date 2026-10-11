package terminal

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"syscall"
	"testing"
)

type testRequest struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type testHost struct {
	socket   string
	mu       sync.Mutex
	requests []testRequest
}

var uuidPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`)

func newTestHost(t *testing.T, handle func(testRequest, int, int) []byte) *testHost {
	t.Helper()
	// Keep the owned Unix socket path below the macOS sockaddr_un limit.
	dir, err := os.MkdirTemp("/tmp", "terminal-test-")
	if err != nil {
		t.Fatal(err)
	}
	host := &testHost{socket: filepath.Join(dir, "rpc.sock")}
	listener, err := net.Listen("unix", host.socket)
	if err != nil {
		if cleanupErr := os.RemoveAll(dir); cleanupErr != nil {
			t.Error(cleanupErr)
		}
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	var connMu sync.Mutex
	connections := map[net.Conn]bool{}
	acceptDone := make(chan struct{})
	go func() {
		defer close(acceptDone)
		connectionIndex := 0
		for {
			conn, err := listener.Accept()
			if err != nil {
				if !errors.Is(err, net.ErrClosed) {
					t.Errorf("fixture accept: %v", err)
				}
				return
			}
			connectionIndex++
			connMu.Lock()
			connections[conn] = true
			connMu.Unlock()
			wg.Add(1)
			go func(connection int) {
				defer wg.Done()
				defer func() {
					if err := conn.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
						t.Errorf("fixture close: %v", err)
					}
					connMu.Lock()
					delete(connections, conn)
					connMu.Unlock()
				}()
				reader := bufio.NewReader(conn)
				index := 0
				for {
					line, err := reader.ReadBytes('\n')
					if err != nil {
						if !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
							t.Errorf("fixture read: %v", err)
						}
						return
					}
					var request testRequest
					if err := json.Unmarshal(line, &request); err != nil {
						t.Errorf("fixture request: %v", err)
						return
					}
					index++
					if !uuidPattern.MatchString(request.ID) {
						t.Error("request does not have a UUIDv4 ID")
					}
					if index == 1 && request.Method != "ping" {
						t.Error("connection did not begin with ping")
					}
					if request.Method != "ping" && request.Method != "agent.get" && request.Method != "pane.read" {
						t.Error("non-read-only method")
					}
					host.mu.Lock()
					for _, prior := range host.requests {
						if prior.ID == request.ID {
							t.Error("reused request identity")
						}
					}
					host.requests = append(host.requests, request)
					host.mu.Unlock()
					response := handle(request, connection, index)
					if response == nil {
						continue
					}
					if _, err := conn.Write(response); err != nil {
						if !errors.Is(err, net.ErrClosed) && !errors.Is(err, syscall.EPIPE) && !errors.Is(err, syscall.ECONNRESET) {
							t.Errorf("fixture write: %v", err)
						}
						return
					} // Client may deliberately reject an oversized fixture frame.
				}
			}(connectionIndex)
		}
	}()
	t.Cleanup(func() {
		if err := listener.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			t.Error(err)
		}
		<-acceptDone
		connMu.Lock()
		for conn := range connections {
			if err := conn.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
				t.Error(err)
			}
		}
		connMu.Unlock()
		wg.Wait()
		if err := os.RemoveAll(dir); err != nil {
			t.Error(err)
		}
	})
	return host
}

func encodedResponse(t *testing.T, request testRequest, result any) []byte {
	t.Helper()
	data, err := json.Marshal(map[string]any{"id": request.ID, "result": result})
	if err != nil {
		t.Errorf("encode fixture: %v", err)
		return nil
	}
	return append(data, '\n')
}

func pongResult() map[string]any {
	return map[string]any{"type": "pong", "protocol": ProtocolVersion, "version": "test"}
}

func agentResult(pane, status string, revision uint64) map[string]any {
	return map[string]any{"pane_id": pane, "terminal_id": "terminal-1", "workspace_id": "w1", "tab_id": "tab-1",
		"agent": "codex", "agent_status": status, "focused": false, "revision": revision,
		"agent_session": map[string]any{"source": "test", "agent": "codex", "kind": "path", "value": "/no-such-private-transcript"}}
}

func snapshotResult(text string, revision uint64) map[string]any {
	return map[string]any{"pane_id": "w1:p1", "workspace_id": "w1", "tab_id": "tab-1", "source": readSource,
		"format": readFormat, "text": text, "revision": revision, "truncated": false}
}

func normalResult(t *testing.T, request testRequest) map[string]any {
	t.Helper()
	switch request.Method {
	case "ping":
		if string(request.Params) != "{}" {
			t.Error("ping parameters were not empty")
		}
		return pongResult()
	case "agent.get":
		var params struct {
			Target string `json:"target"`
		}
		if err := strictDecode(request.Params, &params); err != nil {
			t.Error(err)
		}
		if !panePattern.MatchString(params.Target) {
			t.Error("agent.get target was not explicit")
		}
		return map[string]any{"type": "agent_info", "agent": agentResult(params.Target, "idle", 10)}
	case "pane.read":
		var params map[string]any
		if err := json.Unmarshal(request.Params, &params); err != nil {
			t.Error(err)
		}
		if len(params) != 5 || params["pane_id"] != "w1:p1" || params["source"] != readSource || params["format"] != readFormat || params["strip_ansi"] != true || params["lines"] != float64(SnapshotLines) {
			t.Error("pane.read wire parameters mismatch")
		}
		return map[string]any{"type": "pane_read", "read": snapshotResult("safe terminal text", 10)}
	default:
		t.Error("unexpected RPC method")
		return nil
	}
}

func (h *testHost) methods() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	methods := make([]string, len(h.requests))
	for i, req := range h.requests {
		methods[i] = req.Method
	}
	return methods
}
