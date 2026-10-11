package codex

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

const desktopTestTimeout = 3 * time.Second

// One connection per fixture makes every server goroutine joinable at cleanup.
func desktopFixture(t *testing.T, handler func(*desktopConn) error) string {
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
	accepted := make(chan net.Conn, 1)
	done := make(chan error, 1)
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			done <- acceptErr
			return
		}
		accepted <- conn
		defer conn.Close()
		if deadlineErr := conn.SetDeadline(time.Now().Add(desktopTestTimeout)); deadlineErr != nil {
			done <- deadlineErr
			return
		}
		done <- handler(&desktopConn{Conn: conn})
	}()
	t.Cleanup(func() {
		if closeErr := listener.Close(); closeErr != nil && !errors.Is(closeErr, net.ErrClosed) {
			t.Error(closeErr)
		}
		select {
		case conn := <-accepted:
			if closeErr := conn.Close(); closeErr != nil && !errors.Is(closeErr, net.ErrClosed) {
				t.Error(closeErr)
			}
		default:
		}
		select {
		case serverErr := <-done:
			if serverErr != nil && !errors.Is(serverErr, net.ErrClosed) {
				t.Errorf("desktop fixture: %v", serverErr)
			}
		case <-time.After(desktopTestTimeout):
			t.Error("desktop fixture goroutine did not terminate")
		}
		if cleanupErr := os.RemoveAll(dir); cleanupErr != nil {
			t.Error(cleanupErr)
		}
	})
	return path
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
