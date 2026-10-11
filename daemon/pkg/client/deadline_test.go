package client

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
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	deadlineTestExpiryWindow = 200 * time.Millisecond
	deadlineTestTimeout      = 3 * time.Second
	deadlineAfterExpiry      = 40 * time.Millisecond
	deadlineFixtureMaxFrame  = 1024 * 1024
)

type deadlineAdapter struct {
	receiptAdapter
	operation func(context.Context) error
	calls     atomic.Int32
	writes    atomic.Int32
}

func (a *deadlineAdapter) ReadSession(ctx context.Context, _ string) (string, error) {
	a.calls.Add(1)
	return "deadline fixture read", a.operation(ctx)
}

func (a *deadlineAdapter) SendPrompt(ctx context.Context, _, _ string) (string, error) {
	a.calls.Add(1)
	return "turnId=deadline-turn", a.operation(ctx)
}

func TestCommandExecutionDeadlineIsEarliestForEveryAction(t *testing.T) {
	for _, action := range []protocol.ActionType{protocol.ActionRead, protocol.ActionSend} {
		for _, limit := range []string{"command", "parent", "execution-timeout"} {
			t.Run(string(action)+"/"+limit, func(t *testing.T) {
				started := time.Now()
				cmd := persistenceCommand(started.Add(2 * CommandExecTimeout).UTC().Format(time.RFC3339Nano))
				cmd.Action = action
				ctx := context.Background()
				var want time.Time
				if limit == "command" {
					want = started.Add(time.Second)
					cmd.ExpiresAt = want.UTC().Format(time.RFC3339Nano)
				} else if limit == "parent" {
					want = started.Add(time.Second)
					var cancel context.CancelFunc
					ctx, cancel = context.WithDeadline(ctx, want)
					defer cancel()
				}
				var observed time.Time
				a := &deadlineAdapter{operation: func(ctx context.Context) error {
					var ok bool
					observed, ok = ctx.Deadline()
					if !ok {
						return errors.New("execution context has no deadline")
					}
					return nil
				}}
				d := NewDaemon(persistenceConfig(t.TempDir()), a)
				res := d.ExecuteCommand(ctx, cmd)
				if a.calls.Load() != 1 || res.Status != protocol.StatusCompleted && res.Status != protocol.StatusAccepted {
					t.Fatalf("action did not execute: %+v calls=%d", res, a.calls.Load())
				}
				if limit == "execution-timeout" {
					if observed.Before(started.Add(CommandExecTimeout)) || observed.After(time.Now().Add(CommandExecTimeout)) {
						t.Fatalf("execution budget changed: %v", observed)
					}
				} else if !observed.Equal(want) {
					t.Fatalf("deadline = %v, want earliest %v", observed, want)
				}
			})
		}
	}
}

func waitForDeadline(ctx context.Context) error {
	timer := time.NewTimer(deadlineTestTimeout)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return errors.New("command deadline did not cancel operation")
	}
}

func TestExpiredExecutionForEveryActionIsDurableAndNotReplayed(t *testing.T) {
	for _, action := range []protocol.ActionType{protocol.ActionRead, protocol.ActionSend} {
		t.Run(string(action), func(t *testing.T) {
			a := &deadlineAdapter{operation: waitForDeadline}
			cfg := persistenceConfig(t.TempDir())
			d, err := OpenDaemon(cfg, a)
			if err != nil {
				t.Fatal(err)
			}
			cmd := persistenceCommand(time.Now().Add(deadlineTestExpiryWindow).UTC().Format(time.RFC3339Nano))
			cmd.Action = action
			res := d.ExecuteCommand(context.Background(), cmd)
			want := protocol.StatusFailed
			if action == protocol.ActionSend {
				want = protocol.StatusUncertain
			}
			if res.Status != want || a.calls.Load() != 1 {
				t.Fatalf("deadline result = %+v calls=%d", res, a.calls.Load())
			}
			if replay := d.ExecuteCommand(context.Background(), cmd); replay != res || a.calls.Load() != 1 {
				t.Fatal("expired operation replayed")
			}
			closeDaemon(t, d)
			d, err = OpenDaemon(cfg, a)
			if err != nil {
				t.Fatal(err)
			}
			defer closeDaemon(t, d)
			if replay := d.ExecuteCommand(context.Background(), cmd); replay != res || a.calls.Load() != 1 {
				t.Fatal("restart replayed expired operation")
			}
		})
	}
}

func TestDeadlineAfterMutationRemainsUncertainWithoutResend(t *testing.T) {
	a := &deadlineAdapter{}
	a.operation = func(ctx context.Context) error {
		a.writes.Add(1)
		return waitForDeadline(ctx)
	}
	d, err := OpenDaemon(persistenceConfig(t.TempDir()), a)
	if err != nil {
		t.Fatal(err)
	}
	defer closeDaemon(t, d)
	cmd := persistenceCommand(time.Now().Add(deadlineTestExpiryWindow).UTC().Format(time.RFC3339Nano))
	res := d.ExecuteCommand(context.Background(), cmd)
	if res.Status != protocol.StatusUncertain || a.writes.Load() != 1 {
		t.Fatalf("write deadline misclassified: %+v writes=%d", res, a.writes.Load())
	}
	if replay := d.ExecuteCommand(context.Background(), cmd); replay != res || a.writes.Load() != 1 {
		t.Fatal("ambiguous written input resent")
	}
}

type deadlineDesktopFrame struct {
	Type      string `json:"type"`
	Method    string `json:"method"`
	RequestID string `json:"requestId"`
}

func readDeadlineFrame(conn net.Conn) (deadlineDesktopFrame, error) {
	var frame deadlineDesktopFrame
	var header [4]byte
	if _, err := io.ReadFull(conn, header[:]); err != nil {
		return frame, err
	}
	size := binary.LittleEndian.Uint32(header[:])
	if size == 0 || size > deadlineFixtureMaxFrame {
		return frame, errors.New("invalid deadline fixture frame length")
	}
	data := make([]byte, size)
	if _, err := io.ReadFull(conn, data); err != nil {
		return frame, err
	}
	return frame, json.Unmarshal(data, &frame)
}

func writeDeadlineFrame(conn net.Conn, frame any) error {
	data, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	var buffer bytes.Buffer
	if err := binary.Write(&buffer, binary.LittleEndian, uint32(len(data))); err != nil {
		return err
	}
	if _, err := buffer.Write(data); err != nil {
		return err
	}
	_, err = io.Copy(conn, &buffer)
	return err
}

func deadlineConnectionClosed(err error) bool {
	return errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) ||
		errors.Is(err, syscall.EPIPE) || errors.Is(err, syscall.ECONNRESET)
}

// The real DesktopController reaches its second, in-Dispatch preflight. The
// fixture responds only after command expiry, then watches for mutation frames.
func serveDeadlineDesktop(conn net.Conn, expiry time.Time, preflights, mutations *atomic.Int32) error {
	for {
		request, err := readDeadlineFrame(conn)
		if err != nil {
			if deadlineConnectionClosed(err) && !time.Now().Before(expiry) {
				return nil
			}
			return err
		}
		owner, result := "deadline-owner", any(nil)
		switch request.Method {
		case "initialize":
			owner, result = "deadline-client", map[string]string{"clientId": "deadline-client"}
		case "thread-owner-discovery":
			result = map[string]bool{"supportsUntrustedAppInput": true}
		case "thread-follower-read-model-settings":
			if preflights.Add(1) == 2 {
				timer := time.NewTimer(time.Until(expiry.Add(deadlineAfterExpiry)))
				<-timer.C
			}
			result = map[string]any{"settings": map[string]string{"resumeState": "resumed", "mode": "default", "threadSource": "user"}}
		case "thread-stream-following-changed":
			state := map[string]any{"id": "fixture-session", "hostId": "local", "resumeState": "resumed", "mode": "default", "threadSource": "user", "threadStartKind": "default",
				"threadRuntimeStatus": map[string]any{"type": "idle", "activeFlags": []string{}}, "requests": []any{}, "turns": []any{}}
			err = writeDeadlineFrame(conn, map[string]any{"type": "broadcast", "method": "thread-stream-state-changed", "version": 11,
				"sourceClientId": owner, "targetClientIds": []string{"deadline-client"}, "params": map[string]any{"conversationId": "fixture-session", "hostId": "local",
					"change": map[string]any{"type": "snapshot", "revision": 1, "conversationState": state}}})
			if err == nil {
				continue
			}
		case "thread-follower-start-turn":
			mutations.Add(1)
			result = map[string]any{"result": map[string]any{"turn": map[string]string{"id": "deadline-unexpected-turn"}}}
		default:
			return fmt.Errorf("unexpected deadline fixture method %q", request.Method)
		}
		if err == nil {
			err = writeDeadlineFrame(conn, map[string]any{"type": "response", "requestId": request.RequestID,
				"method": request.Method, "resultType": "success", "handledByClientId": owner, "result": result})
		}
		if err != nil {
			if deadlineConnectionClosed(err) && !time.Now().Before(expiry) {
				return nil
			}
			return err
		}
	}
}

func TestDesktopDispatchPreflightCannotWriteAfterCommandExpiry(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "deadline-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(dir); err != nil {
			t.Error(err)
		}
	})
	path := filepath.Join(dir, "ipc.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := listener.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			t.Error(err)
		}
	})
	control := &receiptAdapter{}
	cfg := persistenceConfig(t.TempDir())
	cfg.DesktopSocketPath = path
	cfg.DesktopSend = true
	d, err := OpenDaemon(cfg, control)
	if err != nil {
		t.Fatal(err)
	}
	defer closeDaemon(t, d)
	expiry := time.Now().Add(deadlineTestExpiryWindow)
	cmd := persistenceCommand(expiry.UTC().Format(time.RFC3339Nano))
	cmd.SendRoute = protocol.RouteDesktopOwner
	var preflights, mutations atomic.Int32
	done := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			done <- err
			return
		}
		if err := conn.SetDeadline(time.Now().Add(deadlineTestTimeout)); err != nil {
			done <- errors.Join(err, conn.Close())
			return
		}
		done <- errors.Join(serveDeadlineDesktop(conn, expiry, &preflights, &mutations), conn.Close())
	}()
	ctx, cancel := context.WithTimeout(context.Background(), deadlineTestTimeout)
	defer cancel()
	res := d.ExecuteCommand(ctx, cmd)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("deadline desktop fixture did not terminate")
	}
	if res.Status != protocol.StatusUncertain && res.Status != protocol.StatusFailed || preflights.Load() != 2 || mutations.Load() != 0 || control.sends.Load() != 0 {
		t.Fatalf("late preflight allowed mutation: %+v preflights=%d desktop writes=%d native sends=%d", res, preflights.Load(), mutations.Load(), control.sends.Load())
	}
	entry, found, err := d.journal.Lookup(cmd)
	if err != nil || !found || !entry.Finished || entry.Dispatch == nil || entry.Dispatch.OwnerID != "deadline-owner" {
		t.Fatalf("deadline lost durable bound identity: %+v found=%t err=%v", entry, found, err)
	}
	if replay := d.ExecuteCommand(context.Background(), cmd); replay != res || mutations.Load() != 0 {
		t.Fatal("deadline desktop dispatch replayed")
	}
}
