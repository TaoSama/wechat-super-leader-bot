package client

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type terminalSendHost struct {
	socket     string
	mu         sync.Mutex
	counts     map[string]int
	texts      []string
	requestIDs []string
	onPrompt   func()
}

func sendHostAgent() map[string]any {
	return map[string]any{"pane_id": "w1:p1", "terminal_id": "terminal-1", "workspace_id": "w1", "tab_id": "tab-1",
		"agent": "codex", "agent_status": "idle", "focused": false, "revision": 10,
		"interactive_ready": true, "launch_pending": false, "screen_detection_skipped": false,
		"agent_session": map[string]any{"source": "test", "agent": "codex", "kind": "path", "value": "/private/transcript-never-read"}}
}

func newTerminalSendHost(t *testing.T, drop bool, mutate func(int, map[string]any)) *terminalSendHost {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "terminal-chain-")
	if err != nil {
		t.Fatal(err)
	}
	h := &terminalSendHost{socket: filepath.Join(dir, "rpc.sock"), counts: make(map[string]int)}
	listener, err := net.Listen("unix", h.socket)
	if err != nil {
		if cleanupErr := os.RemoveAll(dir); cleanupErr != nil {
			t.Error(cleanupErr)
		}
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	var connMu sync.Mutex
	connections := make(map[net.Conn]bool)
	acceptDone := make(chan struct{})
	go func() {
		defer close(acceptDone)
		for {
			conn, err := listener.Accept()
			if err != nil {
				if !errors.Is(err, net.ErrClosed) {
					t.Error(err)
				}
				return
			}
			connMu.Lock()
			connections[conn] = true
			connMu.Unlock()
			workers.Add(1)
			go func() {
				defer workers.Done()
				defer func() {
					if err := conn.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
						t.Error(err)
					}
					connMu.Lock()
					delete(connections, conn)
					connMu.Unlock()
				}()
				reader := bufio.NewReader(conn)
				first := true
				for {
					line, err := reader.ReadBytes('\n')
					if err != nil {
						if !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) && !errors.Is(err, syscall.ECONNRESET) {
							t.Error(err)
						}
						return
					}
					var request struct {
						ID     string          `json:"id"`
						Method string          `json:"method"`
						Params json.RawMessage `json:"params"`
					}
					if err := json.Unmarshal(line, &request); err != nil {
						t.Error(err)
						return
					}
					if first && request.Method != "ping" {
						t.Error("missing handshake")
					}
					first = false
					if !protocol.ValidInputRequestID(request.ID) {
						t.Error("non UUIDv4 RPC id")
					}
					h.mu.Lock()
					h.counts[request.Method]++
					n := h.counts[request.Method]
					h.requestIDs = append(h.requestIDs, request.ID)
					onPrompt := h.onPrompt
					h.mu.Unlock()
					var result any
					switch request.Method {
					case "ping":
						result = map[string]any{"type": "pong", "protocol": 22, "version": "synthetic"}
					case "agent.get":
						var params map[string]string
						if err := json.Unmarshal(request.Params, &params); err != nil {
							t.Error(err)
							return
						}
						if len(params) != 1 || params["target"] != "w1:p1" {
							t.Error("get changed explicit target")
						}
						a := sendHostAgent()
						if mutate != nil {
							mutate(n, a)
						}
						result = map[string]any{"type": "agent_info", "agent": a}
					case "agent.prompt":
						var params map[string]string
						if err := json.Unmarshal(request.Params, &params); err != nil {
							t.Error(err)
							return
						}
						if len(params) != 2 || params["target"] != "w1:p1" {
							t.Error("prompt changed target or added wait")
						}
						h.mu.Lock()
						h.texts = append(h.texts, params["text"])
						h.mu.Unlock()
						if onPrompt != nil {
							onPrompt()
						}
						if drop {
							return
						}
						result = map[string]any{"type": "agent_prompted", "agent": sendHostAgent()}
					default:
						t.Error("unexpected method")
						return
					}
					response, err := json.Marshal(map[string]any{"id": request.ID, "result": result})
					if err != nil {
						t.Error(err)
						return
					}
					if _, err := conn.Write(append(response, '\n')); err != nil {
						if !errors.Is(err, net.ErrClosed) && !errors.Is(err, syscall.EPIPE) && !errors.Is(err, syscall.ECONNRESET) {
							t.Error(err)
						}
						return
					}
				}
			}()
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
		workers.Wait()
		if err := os.RemoveAll(dir); err != nil {
			t.Error(err)
		}
	})
	return h
}

func (h *terminalSendHost) count(method string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.counts[method]
}
func (h *terminalSendHost) prompt() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.texts) == 0 {
		return ""
	}
	return h.texts[0]
}
