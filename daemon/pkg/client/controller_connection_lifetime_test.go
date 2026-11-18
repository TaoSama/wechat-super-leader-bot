package client

import (
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/gorilla/websocket"
)

func TestControllerLifetimeRetainsWriteFailureWhileDiagnosticBlocks(t *testing.T) {
	for _, failAfter := range []time.Duration{9900 * time.Millisecond, 10100 * time.Millisecond} {
		t.Run(failAfter.String(), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				lifetime := newControllerConnectionLifetime(t.Context())
				diagnostic := newControllerSendDiagnostic("blocked-diagnostic")
				blocked, release := make(chan struct{}), make(chan struct{})
				diagnostic.output = func(controllerSendErrorRecord) { close(blocked); <-release }
				cause := errors.New("fixture write failure")
				sender := &controllerSender{conn: &diagnosticWriter{fail: controllerChunkWrite, err: cause}, diagnostic: diagnostic}
				sent := make(chan error, 1)
				go func() {
					time.Sleep(failAfter)
					sent <- sender.sendObserved(protocol.DaemonHeartbeatMessage{Type: "heartbeat"}, lifetime.recordSendFailure)
				}()
				<-blocked
				// A later reader failure wins the error channel while send is still in diagnostic I/O.
				failures := make(chan error, 1)
				go func() {
					time.Sleep(200 * time.Millisecond)
					lifetime.recordFailure(time.Now())
					failures <- io.EOF
				}()
				if err := <-failures; err != io.EOF {
					t.Errorf("reader error changed: %v", err)
				}
				got := lifetime.finish()
				close(release)
				if err := <-sent; err != cause {
					t.Fatalf("sender changed the original error identity: %v", err)
				}
				if got != failAfter || (got > reconnectBackoffResetAfter) != (failAfter > reconnectBackoffResetAfter) {
					t.Fatalf("active=%v want=%v", got, failAfter)
				}
				if time.Since(lifetime.startedAt) <= reconnectBackoffResetAfter {
					t.Fatal("fixture did not cross the stability threshold before consumption")
				}
			})
		})
	}
}

type controllerLifetimeDeadlineWriter struct{ *websocket.Conn }

func (w controllerLifetimeDeadlineWriter) SetWriteDeadline(time.Time) error {
	return w.Conn.SetWriteDeadline(time.Now().Add(100 * time.Millisecond))
}

func TestControllerLifetimeRetainsCommandResultFailureBeforeCachedHeartbeatError(t *testing.T) {
	conn, _ := controllerPipePair(t)
	lifetime := newControllerConnectionLifetime(t.Context())
	diagnostic := newControllerSendDiagnostic("cached-result-failure")
	blocked, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	allowDiagnostic := func() { releaseOnce.Do(func() { close(release) }) }
	diagnostic.output = func(controllerSendErrorRecord) { close(blocked); <-release }
	sender := &controllerSender{conn: controllerLifetimeDeadlineWriter{conn}, diagnostic: diagnostic}
	observed := make(chan time.Time, 1)
	sent := make(chan error, 1)
	workerDone := make(chan struct{})
	defer func() {
		allowDiagnostic()
		select {
		case <-workerDone:
		case <-time.After(time.Second):
			t.Error("result worker did not exit after diagnostic release")
		}
	}()
	go func() {
		defer close(workerDone)
		sent <- sender.sendObserved(protocol.DaemonResultMessage{Type: "result", Output: strings.Repeat("x", 32*1024)},
			func(stage controllerSendStage, at time.Time) {
				lifetime.recordCommandResultFailure(stage, at)
				observed <- at
			})
	}()
	select {
	case <-blocked:
	case <-time.After(time.Second):
		t.Fatal("real Gorilla write did not fail")
	}
	var firstAt time.Time
	select {
	case firstAt = <-observed:
	case <-time.After(time.Second):
		t.Fatal("write failure was not observed before diagnostic output")
	}
	time.Sleep(10 * time.Millisecond)
	heartbeat := make(chan error, 1)
	go func() {
		heartbeat <- sender.sendObserved(protocol.DaemonHeartbeatMessage{Type: "heartbeat"}, lifetime.recordSendFailure)
	}()
	var cached error
	select {
	case cached = <-heartbeat:
	case <-time.After(time.Second):
		allowDiagnostic()
		select {
		case <-heartbeat:
		case <-time.After(time.Second):
			t.Error("heartbeat worker did not exit after diagnostic release")
		}
		t.Fatal("heartbeat waited for diagnostic output")
	}
	got := lifetime.finish()
	allowDiagnostic()
	var first error
	select {
	case first = <-sent:
	case <-time.After(time.Second):
		t.Fatal("result send did not return after diagnostic release")
	}
	var networkError net.Error
	if first == nil || cached != first || !errors.Is(cached, first) || !errors.As(cached, &networkError) || !networkError.Timeout() {
		t.Fatalf("cached Gorilla error identity/type changed: first=%v cached=%v", first, cached)
	}
	if want := firstAt.Sub(lifetime.startedAt); got != want {
		t.Fatalf("active=%v want first command-result observation %v", got, want)
	}
}

func TestControllerLifetimeRecordsCloseBeforeDefaultReplyWait(t *testing.T) {
	conn, remote := controllerPipePair(t)
	lifetime := newControllerConnectionLifetime(t.Context())
	lifetime.startedAt = time.Now().Add(-9500 * time.Millisecond)
	observed := make(chan time.Time, 1)
	handleClose := conn.CloseHandler()
	conn.SetCloseHandler(func(code int, text string) error {
		observed <- time.Now()
		return handleClose(code, text)
	})
	lifetime.trackClose(conn)
	done := make(chan struct{})
	var readErr error
	var active time.Duration
	defer func() {
		if err := conn.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			t.Error(err)
		}
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("close reader did not exit")
		}
	}()
	go func() {
		defer close(done)
		_, _, readErr = conn.ReadMessage()
		lifetime.recordFailure(time.Now())
		active = lifetime.finish()
	}()
	if err := remote.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "fixture close"), time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	var closeAt time.Time
	select {
	case closeAt = <-observed:
	case <-time.After(time.Second):
		t.Fatal("close handler did not start")
	}
	if err := remote.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	// Reading one byte proves the original handler sends a reply, then leaves it blocked.
	var firstReplyByte [1]byte
	if _, err := io.ReadFull(remote.UnderlyingConn(), firstReplyByte[:]); err != nil {
		t.Fatalf("default handler did not attempt a close reply: %v", err)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("default close reply wait was not bounded")
	}
	var closeError *websocket.CloseError
	if !errors.As(readErr, &closeError) || closeError.Code != websocket.CloseNormalClosure || closeError.Text != "fixture close" {
		t.Fatalf("default close error changed: %v", readErr)
	}
	if elapsed := time.Since(lifetime.startedAt); active > closeAt.Sub(lifetime.startedAt) || active >= reconnectBackoffResetAfter || elapsed <= reconnectBackoffResetAfter || elapsed-active < 900*time.Millisecond {
		t.Fatalf("close reply wait counted as active: active=%v elapsed=%v", active, elapsed)
	}
	t.Logf("active=%v total=%v closeCode=%d", active, time.Since(lifetime.startedAt), closeError.Code)
}

func TestControllerLifetimeExcludesNonfatalCommandResultEncodingFailures(t *testing.T) {
	for _, message := range []struct {
		name  string
		value any
	}{
		{"payload", protocol.DaemonResultMessage{Type: "result", Output: string([]byte{0xff})}},
		{"encoding", make(chan int)},
	} {
		for _, commandResult := range []bool{false, true} {
			name := "fatal_" + message.name
			if commandResult {
				name = "command_result_" + message.name
			}
			t.Run(name, func(t *testing.T) {
				synctest.Test(t, func(t *testing.T) {
					lifetime := newControllerConnectionLifetime(t.Context())
					diagnostic := newControllerSendDiagnostic("encoding-lifetime")
					diagnostic.output = func(controllerSendErrorRecord) {}
					sender := &controllerSender{conn: &diagnosticWriter{}, diagnostic: diagnostic}
					observe := lifetime.recordSendFailure
					if commandResult {
						observe = lifetime.recordCommandResultFailure
					}
					time.Sleep(9900 * time.Millisecond)
					if err := sender.sendObserved(message.value, observe); err == nil || message.name == "payload" && err != errControllerPayloadLimit {
						t.Fatalf("encoding failure lost: %v", err)
					}
					time.Sleep(200 * time.Millisecond)
					if err := sender.sendObserved(protocol.DaemonHeartbeatMessage{Type: "heartbeat"}, lifetime.recordSendFailure); err != nil {
						t.Fatalf("rejected encoding damaged usable writer: %v", err)
					}
					want := 9900 * time.Millisecond
					if commandResult {
						want = 10100 * time.Millisecond
					}
					if got := lifetime.finish(); got != want {
						t.Fatalf("active=%v want=%v", got, want)
					}
				})
			})
		}
	}
}

func TestControllerLifetimeIgnoresCleanupAndOldConnectionWorkers(t *testing.T) {
	for _, freeze := range []bool{false, true} {
		name := "cancelled"
		if freeze {
			name = "finished"
		}
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				old := newControllerConnectionLifetime(ctx)
				time.Sleep(11 * time.Second)
				if freeze {
					old.finish()
				} else {
					cancel()
				}
				time.Sleep(time.Second)
				current := newControllerConnectionLifetime(t.Context())
				diagnostic := newControllerSendDiagnostic("old-connection")
				diagnostic.output = func(controllerSendErrorRecord) {}
				sender := &controllerSender{conn: &diagnosticWriter{fail: controllerNextWriter, err: net.ErrClosed}, diagnostic: diagnostic}
				done := make(chan error, 1)
				go func() {
					done <- sender.sendObserved(protocol.DaemonResultMessage{Type: "result"}, old.recordCommandResultFailure)
				}()
				if err := <-done; err != net.ErrClosed {
					t.Fatal(err)
				}
				time.Sleep(time.Second)
				wantOld := 13 * time.Second
				if freeze {
					wantOld = 11 * time.Second
				}
				if got := old.finish(); got != wantOld || !old.firstFailureAt.IsZero() {
					t.Fatalf("late/cleanup failure changed old connection: active=%v failure=%v", got, old.firstFailureAt)
				}
				if got := current.finish(); got != time.Second || !current.firstFailureAt.IsZero() {
					t.Fatalf("old worker contaminated current connection: active=%v failure=%v", got, current.firstFailureAt)
				}
			})
		})
	}
}
