package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/terminal"
)

type syntheticHost struct {
	socket, directory, scenario string
	listener                    net.Listener
	mu                          sync.Mutex
	connections                 map[net.Conn]bool
	wg                          sync.WaitGroup
	acceptDone                  chan struct{}
	failure                     error
	prompts                     int
	revision                    uint64
	session                     string
	status                      string
}

func startSyntheticHost(scenario string) (*syntheticHost, error) {
	directory, err := os.MkdirTemp("/tmp", "terminal-delivery-sample-")
	if err != nil {
		return nil, err
	}
	h := &syntheticHost{directory: directory, socket: filepath.Join(directory, "sample.sock"), scenario: scenario,
		connections: make(map[net.Conn]bool), acceptDone: make(chan struct{}), revision: 1, session: "synthetic-session", status: "idle"}
	h.listener, err = net.Listen("unix", h.socket)
	if err != nil {
		return nil, errors.Join(err, os.RemoveAll(directory))
	}
	go h.accept()
	return h, nil
}

func (h *syntheticHost) recordError(err error) {
	if err == nil || errors.Is(err, net.ErrClosed) {
		return
	}
	h.mu.Lock()
	h.failure = errors.Join(h.failure, err)
	h.mu.Unlock()
}

func (h *syntheticHost) accept() {
	defer close(h.acceptDone)
	for {
		conn, err := h.listener.Accept()
		if err != nil {
			h.recordError(err)
			return
		}
		h.mu.Lock()
		h.connections[conn] = true
		h.mu.Unlock()
		h.wg.Add(1)
		go h.serve(conn)
	}
}

func (h *syntheticHost) serve(conn net.Conn) {
	defer h.wg.Done()
	defer func() {
		h.recordError(conn.Close())
		h.mu.Lock()
		delete(h.connections, conn)
		h.mu.Unlock()
	}()
	reader := bufio.NewReader(conn)
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			if !errors.Is(err, io.EOF) {
				h.recordError(err)
			}
			return
		}
		var request struct {
			ID     string          `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if err := json.Unmarshal(line, &request); err != nil {
			h.recordError(err)
			return
		}
		result, drop, err := h.respond(request.Method, request.Params)
		if err != nil {
			h.recordError(err)
			return
		}
		if drop {
			return
		}
		if err := json.NewEncoder(conn).Encode(map[string]any{"id": request.ID, "result": result}); err != nil {
			h.recordError(err)
			return
		}
	}
}

func (h *syntheticHost) respond(method string, raw json.RawMessage) (any, bool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if method == "ping" {
		if string(raw) != "{}" {
			return nil, false, errors.New("unexpected handshake payload")
		}
		return map[string]any{"type": "pong", "protocol": terminal.ProtocolVersion, "version": "synthetic"}, false, nil
	}
	var params map[string]any
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, false, err
	}
	if params["target"] != samplePane {
		return nil, false, errors.New("synthetic target mismatch")
	}
	responseType := "agent_info"
	agent := map[string]any{"pane_id": samplePane, "terminal_id": "synthetic-terminal", "workspace_id": "w1", "tab_id": "synthetic-tab",
		"agent": "codex", "agent_status": h.status, "revision": h.revision, "focused": false,
		"interactive_ready": true, "launch_pending": false, "screen_detection_skipped": false,
		"agent_session": map[string]any{"source": "synthetic", "agent": "codex", "kind": "id", "value": h.session}}
	switch method {
	case "agent.get":
		if len(params) != 1 {
			return nil, false, errors.New("unexpected read payload")
		}
	case "agent.prompt":
		if len(params) != 2 || params["text"] != samplePrompt {
			return nil, false, errors.New("synthetic prompt changed")
		}
		h.prompts++
		if h.scenario == "acknowledgement-lost" {
			return nil, true, nil
		}
		// The acknowledgement describes the admission snapshot, while the next
		// agent.get observes the running state after the input was written.
		h.status = "working"
		h.revision++
		responseType = "agent_prompted"
	default:
		return nil, false, errors.New("unexpected method at synthetic host")
	}
	return map[string]any{"type": responseType, "agent": agent}, false, nil
}

func (h *syntheticHost) promptCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.prompts
}

func (h *syntheticHost) changeBinding() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.session = "replacement-session"
	h.revision++
}

func (h *syntheticHost) Close() error {
	h.recordError(h.listener.Close())
	<-h.acceptDone
	h.mu.Lock()
	for conn := range h.connections {
		if err := conn.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			h.failure = errors.Join(h.failure, err)
		}
	}
	h.mu.Unlock()
	h.wg.Wait()
	h.mu.Lock()
	err := h.failure
	h.mu.Unlock()
	return errors.Join(err, os.RemoveAll(h.directory))
}
