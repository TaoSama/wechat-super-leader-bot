package desktop

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const controlPoolWaitTimeout = 40 * time.Millisecond

// Unlike the one-connection fixture, this server exercises one controller pool
// across independent synthetic readiness, preparation, and inspection clients.
func desktopControlPoolFixture(t *testing.T, handler func(*desktopConn, int) error) (string, *atomic.Int32) {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "desktop-control-pool-")
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
	var accepted atomic.Int32
	var workers sync.WaitGroup
	var connectionsMu sync.Mutex
	var connections []net.Conn
	done := make(chan struct{})
	serverErrors := make(chan error, 16)
	go func() {
		defer close(done)
		for {
			connection, err := listener.Accept()
			if errors.Is(err, net.ErrClosed) {
				return
			}
			if err != nil {
				serverErrors <- err
				return
			}
			index := int(accepted.Add(1))
			connectionsMu.Lock()
			connections = append(connections, connection)
			connectionsMu.Unlock()
			workers.Add(1)
			go func() {
				defer workers.Done()
				defer func() {
					if err := connection.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
						serverErrors <- err
					}
				}()
				if err := connection.SetDeadline(time.Now().Add(desktopTestTimeout)); err != nil {
					serverErrors <- err
					return
				}
				if err := handler(&desktopConn{Conn: connection}, index); err != nil && !errors.Is(err, net.ErrClosed) {
					serverErrors <- err
				}
			}()
		}
	}()
	t.Cleanup(func() {
		if err := listener.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			t.Error(err)
		}
		<-done
		connectionsMu.Lock()
		for _, connection := range connections {
			if err := connection.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
				t.Error(err)
			}
		}
		connectionsMu.Unlock()
		workers.Wait()
		close(serverErrors)
		for err := range serverErrors {
			t.Error(err)
		}
		if err := os.RemoveAll(dir); err != nil {
			t.Error(err)
		}
	})
	return path, &accepted
}

func TestDesktopControlPoolWaitCancellationAcrossOperations(t *testing.T) {
	controller := NewDesktopController("/desktop-control-pool/must-not-connect")
	for range desktopControlSlots {
		controller.slots <- struct{}{}
	}
	for _, operation := range []string{"readiness", "prepare", "inspect"} {
		t.Run(operation, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), controlPoolWaitTimeout)
			defer cancel()
			var err error
			switch operation {
			case "readiness":
				err = controller.CheckSendReadiness(ctx, "session")
			case "prepare":
				_, err = controller.PrepareSend(ctx, controlRequest())
			case "inspect":
				_, err = controller.InspectTurn(ctx, "session", "target")
			}
			if !errors.Is(err, context.DeadlineExceeded) || len(controller.slots) != desktopControlSlots {
				t.Fatalf("waiting connected or consumed another slot: err=%v slots=%d", err, len(controller.slots))
			}
		})
	}
}

func TestDesktopControlPoolFailuresReleaseSlot(t *testing.T) {
	controller := NewDesktopController("/desktop-control-pool/missing.sock")
	for range desktopControlSlots + 1 {
		if err := controller.CheckSendReadiness(context.Background(), "session"); err == nil || len(controller.slots) != 0 {
			t.Fatalf("failed dial leaked slot: err=%v slots=%d", err, len(controller.slots))
		}
	}
	for _, phase := range []string{"initialize", "discover", "preflight"} {
		t.Run(phase, func(t *testing.T) {
			controller.socketPath = desktopFixture(t, func(c *desktopConn) error {
				if phase == "initialize" {
					request, err := c.read()
					if err != nil {
						return err
					}
					if err := c.write(desktopEnvelope{Type: "response", RequestID: request.RequestID, ResultType: "error"}); err != nil {
						return err
					}
				} else if phase == "discover" {
					if err := desktopHandshakeControlOnly(c); err != nil {
						return err
					}
					request, err := c.read()
					if err != nil {
						return err
					}
					if err := c.write(desktopEnvelope{Type: "response", RequestID: request.RequestID, ResultType: "error"}); err != nil {
						return err
					}
				} else {
					if err := controlHandshake(c); err != nil {
						return err
					}
					state := controlState()
					state["requests"] = []any{map[string]string{"method": "approval"}}
					if err := controlPreflight(c, state, nil); err != nil {
						return err
					}
				}
				return controlExpectClosed(c)
			})
			ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
			defer cancel()
			if err := controller.CheckSendReadiness(ctx, "session"); err == nil || len(controller.slots) != 0 {
				t.Fatalf("%s failure leaked slot: err=%v slots=%d", phase, err, len(controller.slots))
			}
		})
	}
}

func desktopHandshakeControlOnly(c *desktopConn) error {
	request, err := c.read()
	if err != nil {
		return err
	}
	return desktopReply(c, request, "control-client", map[string]string{"clientId": "control-client"})
}

func TestDesktopControlPreparedCloseIsConcurrentAndIdempotent(t *testing.T) {
	path, _ := desktopControlPoolFixture(t, func(c *desktopConn, _ int) error {
		if err := controlHandshake(c); err != nil {
			return err
		}
		if err := controlPreflight(c, controlState(), nil); err != nil {
			return err
		}
		return controlExpectClosed(c)
	})
	ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
	defer cancel()
	controller := NewDesktopController(path)
	var prepared []PreparedDesktopSend
	for range desktopControlSlots {
		p, err := controller.PrepareSend(ctx, controlRequest())
		if err != nil {
			t.Fatal(err)
		}
		prepared = append(prepared, p)
		defer p.Close()
	}
	var workers sync.WaitGroup
	for range 8 {
		workers.Add(1)
		go func() { defer workers.Done(); prepared[0].Close() }()
	}
	workers.Wait()
	if len(controller.slots) != desktopControlSlots-1 {
		t.Fatalf("repeated Close over-released slots: %d", len(controller.slots))
	}
	prepared[1].Close()
	if len(controller.slots) != 0 {
		t.Fatal("final Close retained slot")
	}
}

func TestDesktopControlMixedOperationsShareSlotsUntilClose(t *testing.T) {
	readinessStarted, readinessRelease := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	releaseReadiness := func() { releaseOnce.Do(func() { close(readinessRelease) }) }
	defer releaseReadiness()
	path, accepted := desktopControlPoolFixture(t, func(c *desktopConn, index int) error {
		if err := controlHandshake(c); err != nil {
			return err
		}
		switch index {
		case 1:
			for range 2 {
				if err := controlPreflight(c, controlState(), nil); err != nil {
					return err
				}
			}
			request, err := controlReadDispatch(c)
			if err != nil {
				return err
			}
			if err := desktopReply(c, request, "owner", map[string]any{"result": map[string]any{"turn": map[string]string{"id": "target"}}}); err != nil {
				return err
			}
		case 2:
			request, err := c.read()
			if err != nil {
				return err
			}
			close(readinessStarted)
			<-readinessRelease
			if err := desktopReply(c, request, "owner", map[string]any{"settings": map[string]string{"mode": "default", "threadSource": "user", "resumeState": "resumed"}}); err != nil {
				return err
			}
			if err := controlSnapshot(c, controlState(), nil); err != nil {
				return err
			}
		case 3:
			state := controlState()
			state["turns"] = []any{map[string]any{"turnId": "target", "status": "completed", "items": []any{map[string]string{"type": "agentMessage", "text": "verified"}}}}
			if err := controlSnapshot(c, state, nil); err != nil {
				return err
			}
		default:
			return errors.New("unexpected extra control connection")
		}
		return controlExpectClosed(c)
	})
	ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
	defer cancel()
	controller := NewDesktopController(path)
	prepared, err := controller.PrepareSend(ctx, controlRequest())
	if err != nil {
		t.Fatal(err)
	}
	defer prepared.Close()
	readinessDone := make(chan error, 1)
	go func() { readinessDone <- controller.CheckSendReadiness(ctx, "session") }()
	select {
	case <-readinessStarted:
	case <-ctx.Done():
		t.Fatal("second control operation did not start")
	}
	if turn, err := prepared.Dispatch(ctx, "prompt"); err != nil || turn != "target" || len(controller.slots) != desktopControlSlots {
		t.Fatalf("dispatch lost held slot or reacquired one: turn=%q err=%v slots=%d", turn, err, len(controller.slots))
	}
	inspectionDone := make(chan error, 1)
	go func() {
		result, err := controller.InspectTurn(ctx, "session", "target")
		if err == nil && (result.Status != "completed" || result.Output != "verified") {
			err = errors.New("inspection lost exact target")
		}
		inspectionDone <- err
	}()
	select {
	case err := <-inspectionDone:
		t.Fatalf("inspection bypassed occupied pool: %v", err)
	case <-time.After(controlPoolWaitTimeout):
	}
	if accepted.Load() != desktopControlSlots {
		t.Fatalf("more than two connections opened before Close: %d", accepted.Load())
	}
	prepared.Close()
	select {
	case err := <-inspectionDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("Close did not unblock inspection")
	}
	releaseReadiness()
	select {
	case err := <-readinessDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("readiness worker did not finish")
	}
	if accepted.Load() != desktopControlSlots+1 || len(controller.slots) != 0 {
		t.Fatalf("mixed lifecycle leaked slots: accepted=%d slots=%d", accepted.Load(), len(controller.slots))
	}
}
