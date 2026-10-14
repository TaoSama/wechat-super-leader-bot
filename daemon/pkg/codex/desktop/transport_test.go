package desktop

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

const desktopTestTimeout = 3 * time.Second

func desktopFixture(t *testing.T, handler func(*desktopConn) error) string {
	return desktopConnectionsFixture(t, handler, false)
}

// Both single-connection and streaming fixtures join every accepted handler.
func desktopConnectionsFixture(t *testing.T, handler func(*desktopConn) error, multiple bool) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "desktop-test-")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "ipc.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		if cleanupErr := os.RemoveAll(dir); cleanupErr != nil {
			t.Error(cleanupErr)
		}
		t.Fatal(err)
	}
	var mu sync.Mutex
	connections := make(map[net.Conn]bool)
	var failures []error
	var workers sync.WaitGroup
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				if !errors.Is(acceptErr, net.ErrClosed) {
					mu.Lock()
					failures = append(failures, acceptErr)
					mu.Unlock()
				}
				return
			}
			mu.Lock()
			connections[conn] = true
			mu.Unlock()
			workers.Add(1)
			go func() {
				defer workers.Done()
				serverErr := conn.SetDeadline(time.Now().Add(desktopTestTimeout))
				if serverErr == nil {
					serverErr = handler(&desktopConn{Conn: conn})
				}
				closeErr := conn.Close()
				mu.Lock()
				delete(connections, conn)
				if serverErr != nil && !errors.Is(serverErr, net.ErrClosed) {
					failures = append(failures, serverErr)
				}
				if closeErr != nil && !errors.Is(closeErr, net.ErrClosed) {
					failures = append(failures, closeErr)
				}
				mu.Unlock()
			}()
			if !multiple {
				return
			}
		}
	}()
	t.Cleanup(func() {
		if closeErr := listener.Close(); closeErr != nil && !errors.Is(closeErr, net.ErrClosed) {
			t.Error(closeErr)
		}
		<-done
		mu.Lock()
		for conn := range connections {
			if closeErr := conn.Close(); closeErr != nil && !errors.Is(closeErr, net.ErrClosed) {
				failures = append(failures, closeErr)
			}
		}
		mu.Unlock()
		joined := make(chan struct{})
		go func() { workers.Wait(); close(joined) }()
		select {
		case <-joined:
		case <-time.After(desktopTestTimeout):
			t.Error("desktop fixture goroutine did not terminate")
		}
		mu.Lock()
		for _, serverErr := range failures {
			t.Errorf("desktop fixture: %v", serverErr)
		}
		mu.Unlock()
		if cleanupErr := os.RemoveAll(dir); cleanupErr != nil {
			t.Error(cleanupErr)
		}
	})
	return path
}

func desktopWatchFixture(t *testing.T, owners map[string]string, subscribe func(*desktopConn, string) error, discovery ...func(*desktopConn, desktopEnvelope) error) string {
	t.Helper()
	return desktopConnectionsFixture(t, func(c *desktopConn) error {
		if err := desktopHandshake(c); err != nil {
			return err
		}
		first, err := c.read()
		if err != nil {
			return err
		}
		if first.Method == desktopDiscoverOwner {
			if len(discovery) > 0 {
				return discovery[0](c, first)
			}
			for message := first; ; {
				var params struct {
					ConversationID string `json:"conversationId"`
				}
				if err := json.Unmarshal(message.Params, &params); err != nil {
					return err
				}
				if message.Type != "request" || message.Method != desktopDiscoverOwner {
					return errors.New("discovery connection must not follow state")
				}
				if owner, known := owners[params.ConversationID]; known {
					if err := desktopReply(c, message, owner, nil); err != nil {
						return err
					}
				}
				message, err = c.read()
				if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
					return nil
				}
				if err != nil {
					return err
				}
			}
		}
		var params struct {
			ConversationID string `json:"conversationId"`
			HostID         string `json:"hostId"`
			Following      bool   `json:"following"`
		}
		if err := json.Unmarshal(first.Params, &params); err != nil {
			return err
		}
		owner, known := owners[params.ConversationID]
		if !known || first.Type != "broadcast" || first.Method != desktopFollowingChanged || first.Version != 1 ||
			!params.Following || params.HostID != "local" || len(first.TargetClientIDs) != 1 || first.TargetClientIDs[0] != owner {
			return errors.New("isolated subscription used unproved owner")
		}
		return subscribe(c, params.ConversationID)
	}, true)
}

func desktopReply(c *desktopConn, request desktopEnvelope, owner string, result any) error {
	data, err := json.Marshal(result)
	if err != nil {
		return err
	}
	return c.write(desktopEnvelope{Type: "response", RequestID: request.RequestID, Method: request.Method,
		ResultType: "success", HandledByClientID: owner, Result: data})
}

func desktopHandshake(c *desktopConn) error {
	request, err := c.read()
	if err != nil {
		return err
	}
	var params map[string]string
	if err := json.Unmarshal(request.Params, &params); err != nil {
		return err
	}
	if request.Type != "request" || request.Method != desktopInitialize || request.Version != 0 || request.SourceClientID != "initializing-client" || params["clientType"] != "super-leader-readonly-observer" {
		return fmt.Errorf("unexpected initialization: %+v", request)
	}
	return desktopReply(c, request, "observer-client", map[string]string{"clientId": "observer-client"})
}

func TestDesktopFrameSplitAndInvalidInput(t *testing.T) {
	valid := []byte(`{"type":"broadcast","version":11,"method":"thread-stream-state-changed"}`)
	for _, tc := range []struct {
		name      string
		body      []byte
		size      uint32
		wantError bool
	}{
		{name: "split header and body", body: valid, size: uint32(len(valid))},
		{name: "zero", size: 0, wantError: true},
		{name: "oversized", size: desktopInboundFrameLimit + 1, wantError: true},
		{name: "bad UTF8", body: []byte{0xff}, size: 1, wantError: true},
		{name: "bad JSON", body: []byte("{"), size: 1, wantError: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client, server := net.Pipe()
			defer client.Close()
			done := make(chan error, 1)
			go func() {
				defer server.Close()
				var header [4]byte
				binary.LittleEndian.PutUint32(header[:], tc.size)
				frame := append(header[:], tc.body...)
				for _, value := range frame {
					if _, err := server.Write([]byte{value}); err != nil {
						done <- err
						return
					}
				}
				done <- nil
			}()
			got, err := (&desktopConn{Conn: client}).read()
			if (err != nil) != tc.wantError {
				t.Fatalf("read error = %v", err)
			}
			if err == nil && (got.Method != desktopStateChanged || got.Version != 11) {
				t.Fatalf("split frame corrupted: %+v", got)
			}
			if err := <-done; err != nil {
				t.Fatal(err)
			}
		})
	}
}

type desktopDeadlineFailureConn struct {
	*desktopFramePolicyConn
	deadlineErr error
}

func (c desktopDeadlineFailureConn) SetReadDeadline(time.Time) error { return c.deadlineErr }

func TestDesktopBudgetedFrameFailureReleasesSlot(t *testing.T) {
	projectionErr := errors.New("strict projection failed")
	deadlineErr := errors.New("read deadline failed")
	for _, tc := range []struct {
		name        string
		body        []byte
		deadlineErr error
		consumeErr  error
		wantError   error
	}{
		{name: "deadline", body: []byte(`{}`), deadlineErr: deadlineErr, wantError: deadlineErr},
		{name: "UTF8", body: []byte{0xff}},
		{name: "JSON", body: []byte("{")},
		{name: "short body", body: nil},
		{name: "strict projection", body: []byte(`{}`), consumeErr: projectionErr, wantError: projectionErr},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var header [4]byte
			size := len(tc.body)
			if size == 0 {
				size = 1
			}
			binary.LittleEndian.PutUint32(header[:], uint32(size))
			spy := &desktopFramePolicyConn{reader: bytes.NewReader(append(header[:], tc.body...))}
			connection := desktopDeadlineFailureConn{desktopFramePolicyConn: spy, deadlineErr: tc.deadlineErr}
			budget := newDesktopFrameBudget(1, time.Second)
			consumed := false
			err := (&desktopConn{Conn: connection}).readBudgeted(context.Background(), budget, func(desktopEnvelope) error {
				consumed = true
				if len(budget.slots) != 1 {
					t.Error("projection ran outside budget")
				}
				return tc.consumeErr
			})
			if err == nil || (tc.wantError != nil && !errors.Is(err, tc.wantError)) || len(budget.slots) != 0 || consumed != (tc.consumeErr != nil) {
				t.Fatalf("failure leaked/escaped slot: err=%v slots=%d consumed=%v", err, len(budget.slots), consumed)
			}
			if tc.deadlineErr != nil && len(spy.readSizes) != 1 {
				t.Fatalf("body read after deadline failure: %v", spy.readSizes)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			if err := budget.acquire(ctx); err != nil {
				t.Fatalf("failed frame blocked next reader: %v", err)
			}
			budget.release()
		})
	}
}

type desktopShortWriter struct{ net.Conn }

func (c desktopShortWriter) Write(data []byte) (int, error) {
	const chunkSize = 3
	if len(data) > chunkSize {
		data = data[:chunkSize]
	}
	return c.Conn.Write(data)
}

func TestDesktopFramePartialWrites(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	done := make(chan error, 1)
	go func() {
		done <- (&desktopConn{Conn: desktopShortWriter{client}}).write(desktopEnvelope{Type: "broadcast", Method: desktopStateChanged, Version: 11})
	}()
	got, err := (&desktopConn{Conn: server}).read()
	if err != nil || got.Method != desktopStateChanged {
		t.Fatalf("partial write frame = %+v, %v", got, err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestDesktopRequestMatchesExactIDAndSuccessMethod(t *testing.T) {
	for _, wrongMethod := range []bool{false, true} {
		t.Run(fmt.Sprintf("wrong method %v", wrongMethod), func(t *testing.T) {
			path := desktopFixture(t, func(c *desktopConn) error {
				request, err := c.read()
				if err != nil {
					return err
				}
				noise := request
				noise.RequestID = "not-the-request"
				if err := desktopReply(c, noise, "owner", nil); err != nil {
					return err
				}
				if wrongMethod {
					request.Method = "different-method"
				}
				return desktopReply(c, request, "owner", nil)
			})
			conn, err := net.Dial("unix", path)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			response, err := (&desktopConn{Conn: conn, clientID: "observer"}).request(context.Background(), desktopDiscoverOwner, 1, nil)
			if (err != nil) != wrongMethod || response.RequestID == "not-the-request" {
				t.Fatalf("response = %+v, error = %v", response, err)
			}
		})
	}
}

func TestDesktopInitializeOwnerIdentity(t *testing.T) {
	for _, tc := range []struct {
		name, client, handledBy string
		reject                  bool
	}{
		{"exact", "observer-client", "observer-client", false},
		{"invalid identity", "invalid identity", "invalid identity", true},
		{"different handler", "observer-client", "other-client", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := desktopFixture(t, func(c *desktopConn) error {
				request, err := c.read()
				if err != nil {
					return err
				}
				return desktopReply(c, request, tc.handledBy, map[string]string{"clientId": tc.client})
			})
			c, cleanup, err := connectDesktop(context.Background(), path)
			if cleanup != nil {
				cleanup()
			}
			if (err != nil) != tc.reject {
				t.Fatalf("connect = %v, error = %v", c, err)
			}
		})
	}
}

func desktopExpectClosed(c *desktopConn) error {
	_, err := c.read()
	if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
		return nil
	}
	return fmt.Errorf("expected closed observer connection, got %v", err)
}
