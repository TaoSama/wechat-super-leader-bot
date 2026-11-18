package client

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/gorilla/websocket"
)

func TestControllerReconnectBackoffAcrossAttempts(t *testing.T) {
	for _, scenario := range []struct {
		name      string
		elapsed   time.Duration
		connected time.Duration
	}{
		{"long_failed_dials", 11 * time.Second, 0},
		{"short_connections_with_slow_cleanup", 12 * time.Second, time.Second},
		{"exact_stability_threshold", 11 * time.Second, reconnectBackoffResetAfter},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				d := NewDaemon(&config.Config{NodeID: "backoff-fixture"}, nil)
				want := []time.Duration{500 * time.Millisecond, time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 15 * time.Second, 15 * time.Second}
				var ended time.Time
				attempts := 0
				err := d.runControllerReconnectLoop(ctx, func(context.Context) (time.Duration, error) {
					if attempts > 0 && time.Since(ended) != want[attempts-1] {
						t.Errorf("retry %d delay = %v; want %v", attempts, time.Since(ended), want[attempts-1])
					}
					attempts++
					if attempts > len(want) {
						cancel()
					}
					time.Sleep(scenario.elapsed)
					ended = time.Now()
					return scenario.connected, errors.New("isolated attempt failure")
				})
				if !errors.Is(err, context.Canceled) || attempts != len(want)+1 {
					t.Fatalf("attempts=%d err=%v", attempts, err)
				}
			})
		})
	}
}

func TestControllerReconnectStableHelloResetsBackoff(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		d := NewDaemon(&config.Config{NodeID: "stable-fixture"}, nil)
		want := []time.Duration{500 * time.Millisecond, time.Second, 500 * time.Millisecond, time.Second}
		var ended time.Time
		attempts := 0
		err := d.runControllerReconnectLoop(ctx, func(context.Context) (time.Duration, error) {
			if attempts > 0 && time.Since(ended) != want[attempts-1] {
				t.Errorf("retry %d delay = %v; want %v", attempts, time.Since(ended), want[attempts-1])
			}
			attempts++
			connected := time.Duration(0)
			if attempts == 3 {
				connected = reconnectBackoffResetAfter + time.Nanosecond
			}
			time.Sleep(connected)
			ended = time.Now()
			if attempts > len(want) {
				cancel()
			}
			return connected, errors.New("isolated connection ended")
		})
		if !errors.Is(err, context.Canceled) || attempts != len(want)+1 {
			t.Fatalf("attempts=%d err=%v", attempts, err)
		}
	})
}

func TestControllerReconnectWaitCancelsPromptly(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		d := NewDaemon(&config.Config{NodeID: "cancel-fixture"}, nil)
		done := make(chan error, 1)
		attempts := 0
		started := time.Now()
		go func() {
			done <- d.runControllerReconnectLoop(ctx, func(context.Context) (time.Duration, error) {
				attempts++
				return 0, errors.New("isolated dial failure")
			})
		}()
		synctest.Wait()
		time.Sleep(100 * time.Millisecond)
		cancel()
		if err := <-done; !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
		if elapsed := time.Since(started); elapsed != 100*time.Millisecond || attempts != 1 {
			t.Fatalf("cancellation took %v; attempts=%d", elapsed, attempts)
		}
	})
}

type reconnectCleanupAdapter struct {
	started  chan struct{}
	once     sync.Once
	cleanup  time.Duration
	announce bool
}

func (a *reconnectCleanupAdapter) DiscoverSessions(ctx context.Context) ([]protocol.Session, error) {
	if a.announce {
		a.once.Do(func() { close(a.started) })
	}
	<-ctx.Done()
	time.Sleep(a.cleanup)
	return nil, ctx.Err()
}
func (*reconnectCleanupAdapter) ReadSession(context.Context, string) (string, error) {
	return "", errors.New("unexpected read")
}
func (*reconnectCleanupAdapter) SendPrompt(context.Context, string, string) (string, error) {
	return "", errors.New("unexpected send")
}

func TestControllerConnectionLifetimeExcludesHandshakeAndCleanup(t *testing.T) {
	const handshakeDelay = 150 * time.Millisecond
	const cleanupDelay = 150 * time.Millisecond
	for _, announce := range []bool{true, false} {
		t.Run(fmt.Sprintf("adapter_announced_%t", announce), func(t *testing.T) {
			timeout := 5 * time.Second
			if !announce {
				timeout = 500 * time.Millisecond
			}
			ctx, cancel := context.WithTimeout(t.Context(), timeout)
			defer cancel()
			adapter := &reconnectCleanupAdapter{started: make(chan struct{}), cleanup: cleanupDelay, announce: announce}
			fixtureErrors := make(chan error, 1)
			handlerDone := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				defer close(handlerDone)
				time.Sleep(handshakeDelay)
				upgrader := websocket.Upgrader{}
				conn, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					fixtureErrors <- err
					return
				}
				defer func() {
					if err := conn.Close(); err != nil {
						t.Error(err)
					}
				}()
				var hello protocol.DaemonHelloMessage
				if err := conn.ReadJSON(&hello); err != nil {
					fixtureErrors <- err
					return
				}
				select {
				case <-adapter.started:
				case <-ctx.Done():
					fixtureErrors <- ctx.Err()
					return
				}
				fixtureErrors <- conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "fixture finished"), time.Now().Add(time.Second))
			}))
			defer server.Close()
			defer func() {
				cancel()
				timer := time.NewTimer(time.Second)
				defer timer.Stop()
				select {
				case <-handlerDone:
				case <-timer.C:
					t.Error("lifetime fixture handler did not exit")
				}
			}()
			d := NewDaemon(&config.Config{NodeID: "lifetime-fixture", ControllerURL: "ws" + strings.TrimPrefix(server.URL, "http")}, adapter)
			started := time.Now()
			connectedFor, connectionErr := d.runControllerConnection(ctx)
			if !announce && (!errors.Is(ctx.Err(), context.DeadlineExceeded) || time.Since(started) >= 2*time.Second) {
				t.Fatalf("missing adapter startup did not exit at its deadline: context=%v connection=%v", ctx.Err(), connectionErr)
			}
			if connectionErr == nil {
				t.Fatal("expected fixture close")
			}
			fixtureWait := time.NewTimer(time.Second)
			defer fixtureWait.Stop()
			select {
			case err := <-fixtureErrors:
				if announce && err != nil || !announce && !errors.Is(err, context.DeadlineExceeded) {
					t.Fatal(err)
				}
			case <-fixtureWait.C:
				t.Fatalf("fixture did not finish: %v; connection: %v", ctx.Err(), connectionErr)
			}
			if !announce {
				return
			}
			if total := time.Since(started); connectedFor <= 0 || total-connectedFor < handshakeDelay+cleanupDelay {
				t.Fatalf("active=%v total=%v includes handshake or cleanup", connectedFor, total)
			}
		})
	}
}

func TestControllerFailedHelloHasNoActiveLifetime(t *testing.T) {
	fixtureDone := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(fixtureDone)
		upgrader := websocket.Upgrader{}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer func() {
			if err := conn.Close(); err != nil {
				t.Error(err)
			}
		}()
		if _, _, err := conn.ReadMessage(); err == nil {
			t.Error("oversized hello reached fixture")
		}
	}))
	defer server.Close()
	d := NewDaemon(&config.Config{NodeID: strings.Repeat("x", protocol.MaxControllerMessageBytes), ControllerURL: "ws" + strings.TrimPrefix(server.URL, "http")}, nil)
	connectedFor, err := d.runControllerConnection(t.Context())
	if !errors.Is(err, errControllerPayloadLimit) || connectedFor != 0 {
		t.Fatalf("active=%v error=%v", connectedFor, err)
	}
	<-fixtureDone
}

func TestControllerFailedDialHasNoActiveLifetime(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "fixture rejection", http.StatusForbidden)
	}))
	defer server.Close()
	d := NewDaemon(&config.Config{NodeID: "rejected-fixture", ControllerURL: "ws" + strings.TrimPrefix(server.URL, "http")}, nil)
	connectedFor, err := d.runControllerConnection(t.Context())
	if err == nil || !strings.Contains(err.Error(), "HTTP 403") || connectedFor != 0 {
		t.Fatalf("active=%v error=%v", connectedFor, err)
	}
}
