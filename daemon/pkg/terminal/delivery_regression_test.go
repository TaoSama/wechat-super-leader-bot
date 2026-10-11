package terminal

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

const regressionRequestID = "017de777-b296-42cb-a229-d3d7af3038e5"
const regressionPrompt = "请核对中文投递。\n第二行\t保留原文。"

type regressionHost struct {
	socket   string
	mu       sync.Mutex
	requests []testRequest
	counts   map[string]int
}

// The existing observation fixture deliberately rejects agent.prompt. Keep its
// allowlist intact and isolate mutation-capable synthetic hosts in this file.
func newRegressionHost(t *testing.T, handle func(testRequest, int) []byte) *regressionHost {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "terminal-delivery-regression-")
	if err != nil {
		t.Fatal(err)
	}
	h := &regressionHost{socket: filepath.Join(dir, "rpc.sock"), counts: make(map[string]int)}
	listener, err := net.Listen("unix", h.socket)
	if err != nil {
		if cleanupErr := os.RemoveAll(dir); cleanupErr != nil {
			t.Error(cleanupErr)
		}
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	var connMu sync.Mutex
	connections := make(map[net.Conn]struct{})
	acceptDone := make(chan struct{})
	go func() {
		defer close(acceptDone)
		for {
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				if !errors.Is(acceptErr, net.ErrClosed) {
					t.Errorf("regression accept: %v", acceptErr)
				}
				return
			}
			connMu.Lock()
			connections[conn] = struct{}{}
			connMu.Unlock()
			workers.Add(1)
			go func() {
				defer workers.Done()
				defer func() {
					if closeErr := conn.Close(); closeErr != nil && !errors.Is(closeErr, net.ErrClosed) {
						t.Error(closeErr)
					}
					connMu.Lock()
					delete(connections, conn)
					connMu.Unlock()
				}()
				reader := bufio.NewReader(conn)
				for {
					line, readErr := reader.ReadBytes('\n')
					if readErr != nil {
						if !errors.Is(readErr, io.EOF) && !errors.Is(readErr, net.ErrClosed) && !errors.Is(readErr, syscall.ECONNRESET) {
							t.Errorf("regression read: %v", readErr)
						}
						return
					}
					var request testRequest
					if decodeErr := json.Unmarshal(line, &request); decodeErr != nil {
						t.Error(decodeErr)
						return
					}
					h.mu.Lock()
					h.requests = append(h.requests, request)
					h.counts[request.Method]++
					index := h.counts[request.Method]
					h.mu.Unlock()
					response := handle(request, index)
					if response == nil {
						return
					}
					if _, writeErr := conn.Write(response); writeErr != nil {
						if !errors.Is(writeErr, net.ErrClosed) && !errors.Is(writeErr, syscall.EPIPE) && !errors.Is(writeErr, syscall.ECONNRESET) {
							t.Error(writeErr)
						}
						return
					}
				}
			}()
		}
	}()
	t.Cleanup(func() {
		if closeErr := listener.Close(); closeErr != nil && !errors.Is(closeErr, net.ErrClosed) {
			t.Error(closeErr)
		}
		<-acceptDone
		connMu.Lock()
		for conn := range connections {
			if closeErr := conn.Close(); closeErr != nil && !errors.Is(closeErr, net.ErrClosed) {
				t.Error(closeErr)
			}
		}
		connMu.Unlock()
		workers.Wait()
		if cleanupErr := os.RemoveAll(dir); cleanupErr != nil {
			t.Error(cleanupErr)
		}
	})
	return h
}

func (h *regressionHost) count(method string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.counts[method]
}

func regressionAgent() map[string]any {
	a := agentResult("w1:p1", "idle", 10)
	a["interactive_ready"] = true
	a["launch_pending"] = false
	a["screen_detection_skipped"] = false
	return a
}

func regressionResponse(t *testing.T, request testRequest) []byte {
	t.Helper()
	switch request.Method {
	case "ping":
		return encodedResponse(t, request, pongResult())
	case "agent.get":
		return encodedResponse(t, request, map[string]any{"type": "agent_info", "agent": regressionAgent()})
	case "agent.prompt":
		return encodedResponse(t, request, map[string]any{"type": "agent_prompted", "agent": regressionAgent()})
	default:
		t.Errorf("unexpected regression method: %s", request.Method)
		return nil
	}
}

func prepareRegression(t *testing.T, h *regressionHost, ctx context.Context) *PreparedDelivery {
	t.Helper()
	o := NewObserver(h.socket, []string{"w1:p1"})
	sessions, err := o.DiscoverSessions(context.Background())
	if err != nil || len(sessions) != 1 {
		t.Fatalf("discover: count=%d err=%v", len(sessions), err)
	}
	p, err := NewDeliveryController(o).PrepareDelivery(ctx, sessions[0].ID, regressionRequestID, regressionPrompt)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if closeErr := p.Close(); closeErr != nil {
			t.Error(closeErr)
		}
	})
	if h.count("agent.prompt") != 0 {
		t.Fatal("prepare sent input")
	}
	return p
}

func assertRegressionFailure(t *testing.T, receipt DeliveryReceipt, err error, attempted bool) {
	t.Helper()
	var deliveryErr *DeliveryError
	if err == nil || !errors.As(err, &deliveryErr) {
		t.Fatalf("missing structured delivery error: %v", err)
	}
	if deliveryErr.Attempted != attempted || deliveryErr.Uncertain != attempted {
		t.Fatalf("attempt classification: attempted=%v uncertain=%v want=%v", deliveryErr.Attempted, deliveryErr.Uncertain, attempted)
	}
	if receipt.Kind != "" {
		t.Fatalf("failure returned a receipt: %+v", receipt)
	}
}

func TestDeliveryRegressionPrepareThenInvalidate(t *testing.T) {
	for _, mode := range []string{"close", "expiry", "prepare-cancel", "dispatch-cancel"} {
		t.Run(mode, func(t *testing.T) {
			h := newRegressionHost(t, func(r testRequest, _ int) []byte { return regressionResponse(t, r) })
			prepareCtx, cancelPrepare := context.WithCancel(context.Background())
			defer cancelPrepare()
			p := prepareRegression(t, h, prepareCtx)
			dispatchCtx, cancelDispatch := context.WithCancel(context.Background())
			defer cancelDispatch()
			switch mode {
			case "close":
				if err := p.Close(); err != nil {
					t.Fatal(err)
				}
				if err := p.Close(); err != nil {
					t.Fatal("second close:", err)
				}
			case "expiry":
				p.deadline = time.Now().Add(-time.Second)
			case "prepare-cancel":
				cancelPrepare()
			case "dispatch-cancel":
				cancelDispatch()
			}
			receipt, err := p.Dispatch(dispatchCtx)
			assertRegressionFailure(t, receipt, err, false)
			if _, err := p.Dispatch(context.Background()); err == nil {
				t.Fatal("invalid preparation reused")
			}
			if h.count("agent.prompt") != 0 {
				t.Fatal("invalid preparation wrote input")
			}
		})
	}
}

func TestDeliveryRegressionBindingAndRevisionChanges(t *testing.T) {
	mutations := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"same-pane-session", func(a map[string]any) { a["agent_session"].(map[string]any)["value"] = "different-session" }},
		{"same-pane-session-source", func(a map[string]any) { a["agent_session"].(map[string]any)["source"] = "different-reporter" }},
		{"same-pane-terminal", func(a map[string]any) { a["terminal_id"] = "new-terminal" }},
		{"revision-increased", func(a map[string]any) { a["revision"] = 11 }},
		{"revision-regressed", func(a map[string]any) { a["revision"] = 9 }},
		{"shell-ready-false", func(a map[string]any) { a["interactive_ready"] = false }},
	}
	for _, phase := range []string{"before", "after"} {
		for _, mutation := range mutations {
			if phase == "after" && (mutation.name == "revision-increased" || mutation.name == "shell-ready-false") {
				continue
			}
			t.Run(phase+"/"+mutation.name, func(t *testing.T) {
				h := newRegressionHost(t, func(r testRequest, n int) []byte {
					if r.Method == "agent.get" && ((phase == "before" && n == 3) || (phase == "after" && n == 4)) {
						a := regressionAgent()
						mutation.mutate(a)
						return encodedResponse(t, r, map[string]any{"type": "agent_info", "agent": a})
					}
					return regressionResponse(t, r)
				})
				p := prepareRegression(t, h, context.Background())
				receipt, err := p.Dispatch(context.Background())
				assertRegressionFailure(t, receipt, err, phase == "after")
				if _, err := p.Dispatch(context.Background()); err == nil {
					t.Fatal("changed-target preparation reused")
				}
				wantPrompts := 0
				if phase == "after" {
					wantPrompts = 1
				}
				if h.count("agent.prompt") != wantPrompts {
					t.Fatalf("prompts=%d want=%d", h.count("agent.prompt"), wantPrompts)
				}
			})
		}
	}
}

func TestDeliveryRegressionLostOrPartialReceipt(t *testing.T) {
	for _, mode := range []string{"lost", "partial", "wrong-response-id"} {
		t.Run(mode, func(t *testing.T) {
			h := newRegressionHost(t, func(r testRequest, _ int) []byte {
				if r.Method != "agent.prompt" {
					return regressionResponse(t, r)
				}
				switch mode {
				case "lost":
					return nil
				case "partial":
					return []byte("{\"id\":\"partial")
				default:
					r.ID = "017de777-b296-42cb-a229-d3d7af3038e6"
					return regressionResponse(t, r)
				}
			})
			p := prepareRegression(t, h, context.Background())
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			receipt, err := p.Dispatch(ctx)
			assertRegressionFailure(t, receipt, err, true)
			for _, private := range []string{h.socket, regressionPrompt, "/no-such-private-transcript"} {
				if strings.Contains(err.Error(), private) {
					t.Fatal("delivery error leaked private data")
				}
			}
			if _, err := p.Dispatch(context.Background()); err == nil {
				t.Fatal("uncertain dispatch reused")
			}
			if h.count("agent.prompt") != 1 {
				t.Fatal("uncertain dispatch was retried")
			}
		})
	}
}

func TestDeliveryRegressionConcurrentDispatch(t *testing.T) {
	h := newRegressionHost(t, func(r testRequest, n int) []byte {
		if r.Method == "agent.get" && n == 4 {
			a := regressionAgent()
			a["agent_status"] = "working"
			a["revision"] = 11
			return encodedResponse(t, r, map[string]any{"type": "agent_info", "agent": a})
		}
		if r.Method == "agent.prompt" {
			var params struct {
				Target string `json:"target"`
				Text   string `json:"text"`
			}
			if err := strictDecode(r.Params, &params); err != nil {
				t.Error(err)
			}
			if params.Target != "w1:p1" || params.Text != regressionPrompt {
				t.Error("prompt target/text changed")
			}
		}
		return regressionResponse(t, r)
	})
	p := prepareRegression(t, h, context.Background())
	identity := p.Identity()
	identity.PaneID = "w1:p99"
	identity.RequestID = "changed"
	if p.Identity().PaneID != "w1:p1" || p.Identity().RequestID != regressionRequestID {
		t.Fatal("identity exposed mutable storage")
	}
	const callers = 20
	start := make(chan struct{})
	results := make(chan error, callers)
	var workers sync.WaitGroup
	for i := 0; i < callers; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			receipt, err := p.Dispatch(context.Background())
			if err == nil {
				if receipt.Kind != "terminal-input-written" || receipt.SessionID != p.Identity().SessionID || receipt.RequestID != regressionRequestID || receipt.PromptSHA256 != p.Identity().PromptSHA256 {
					t.Error("invalid input receipt")
				}
				data, marshalErr := json.Marshal(receipt)
				if marshalErr != nil {
					t.Error(marshalErr)
				}
				var fields map[string]json.RawMessage
				if decodeErr := json.Unmarshal(data, &fields); decodeErr != nil {
					t.Error(decodeErr)
				}
				for field := range fields {
					if strings.EqualFold(field, "turnId") || strings.EqualFold(field, "completed") || strings.EqualFold(field, "output") {
						t.Error("input receipt claims task completion")
					}
				}
			}
			results <- err
		}()
	}
	close(start)
	workers.Wait()
	close(results)
	successes := 0
	for err := range results {
		if err == nil {
			successes++
		}
	}
	if successes != 1 || h.count("agent.prompt") != 1 {
		t.Fatalf("successes=%d prompts=%d", successes, h.count("agent.prompt"))
	}
}

func TestDeliveryRegressionConcurrentClose(t *testing.T) {
	h := newRegressionHost(t, func(r testRequest, _ int) []byte { return regressionResponse(t, r) })
	p := prepareRegression(t, h, context.Background())
	start := make(chan struct{})
	dispatched := make(chan struct{})
	go func() {
		defer close(dispatched)
		<-start
		receipt, err := p.Dispatch(context.Background())
		if err != nil {
			var deliveryErr *DeliveryError
			if !errors.As(err, &deliveryErr) || receipt.Kind != "" {
				t.Errorf("close race error: %v receipt=%+v", err, receipt)
			}
		} else if receipt.Kind != "terminal-input-written" {
			t.Error("close race returned invalid success")
		}
	}()
	const closers = 20
	var workers sync.WaitGroup
	for i := 0; i < closers; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			if err := p.Close(); err != nil {
				t.Error(err)
			}
		}()
	}
	close(start)
	workers.Wait()
	<-dispatched
	if h.count("agent.prompt") > 1 {
		t.Fatal("close race duplicated input")
	}
	before := h.count("agent.prompt")
	if _, err := p.Dispatch(context.Background()); err == nil {
		t.Fatal("closed preparation reused")
	}
	if h.count("agent.prompt") != before {
		t.Fatal("closed preparation retried")
	}
}

type regressionPartialWriter struct {
	net.Conn
	mu           sync.Mutex
	promptWrites int
	promptBytes  int
}

func (c *regressionPartialWriter) Write(data []byte) (int, error) {
	var request testRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return 0, err
	}
	if request.Method != "agent.prompt" {
		return c.Conn.Write(data)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.promptWrites++
	n, err := c.Conn.Write(data[:len(data)/2])
	c.promptBytes += n
	if err != nil {
		return n, err
	}
	return n, io.ErrUnexpectedEOF
}

func TestDeliveryRegressionPartialPromptWrite(t *testing.T) {
	h := newRegressionHost(t, func(r testRequest, _ int) []byte { return regressionResponse(t, r) })
	p := prepareRegression(t, h, context.Background())
	partial := &regressionPartialWriter{Conn: p.client.conn}
	p.client.conn = partial
	receipt, err := p.Dispatch(context.Background())
	assertRegressionFailure(t, receipt, err, true)
	if _, err := p.Dispatch(context.Background()); err == nil {
		t.Fatal("partial write dispatch reused")
	}
	partial.mu.Lock()
	writes, bytes := partial.promptWrites, partial.promptBytes
	partial.mu.Unlock()
	if writes != 1 || bytes <= 0 {
		t.Fatalf("partial write proof: writes=%d bytes=%d", writes, bytes)
	}
	if h.count("agent.prompt") != 0 {
		t.Fatal("fixture received a complete prompt frame")
	}
}
