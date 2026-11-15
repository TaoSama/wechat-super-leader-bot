package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestDesktopSubscriptionDiagnosticsWatchFailures(t *testing.T) {
	for _, failure := range []string{"wrong-owner", "revision-gap", "revoked"} {
		t.Run(failure, func(t *testing.T) {
			output := captureDesktopSubscriptionLogs(t)
			var attempts atomic.Int32
			path, waitIdle := isolationFixture(t, func(c *desktopConn, id string) error {
				attempts.Add(1)
				if err := isolationSnapshot(c, id); err != nil {
					return err
				}
				if failure == "revoked" {
					params, err := json.Marshal(map[string]any{"conversationId": id, "hostId": "local", "following": false})
					if err != nil {
						return err
					}
					if err := c.write(desktopEnvelope{Type: "broadcast", Method: desktopFollowingChanged, Version: 1, SourceClientID: "owner-" + id, TargetClientIDs: []string{c.clientID}, Params: params}); err != nil {
						return err
					}
				} else {
					owner, base := "owner-"+id, uint64(9)
					if failure == "wrong-owner" {
						owner, base = subscriptionDiagnosticSecret, 1
					}
					if err := isolationState(c, id, owner, desktopPatchChange(base, base+1)); err != nil {
						return err
					}
				}
				return isolationUnfollowOrClose(c, id)
			})
			observer := NewDesktopObserver(path)
			observer.watchWindow = 80 * time.Millisecond
			ctx, cancel := context.WithTimeout(context.Background(), isolationWait)
			defer cancel()
			if err := observer.Watch(ctx, []string{"session"}, func(string, protocol.DesktopObservation) {}); err != nil {
				t.Fatal(err)
			}
			waitIdle()
			if attempts.Load() != 1 {
				t.Fatalf("failed target retried within the same window: %d", attempts.Load())
			}
			stage, class := "apply-state", "other-rejected"
			if failure == "revoked" {
				stage, class = "revocation", "owner-unavailable"
			}
			assertDesktopSubscriptionLog(t, output.String(), "invalid-state-or-transport", stage, class, false)
		})
	}
}

func TestDesktopSubscriptionDiagnosticsCancellationWinsTransportClosure(t *testing.T) {
	for _, deadline := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancel", true: "deadline"}[deadline], func(t *testing.T) {
			output := captureDesktopSubscriptionLogs(t)
			cancelAfterFollow := make(chan context.CancelFunc, 1)
			path := desktopFixture(t, func(c *desktopConn) error {
				if err := desktopHandshake(c); err != nil {
					return err
				}
				if err := desktopReadFollow(c, "session", "owner", true); err != nil {
					return err
				}
				if !deadline {
					(<-cancelAfterFollow)()
				}
				return desktopExpectClosed(c)
			})
			ctx, cancel := context.WithTimeout(context.Background(), isolationWait)
			want := context.Canceled
			if deadline {
				cancel()
				ctx, cancel = context.WithTimeout(context.Background(), 250*time.Millisecond)
				want = context.DeadlineExceeded
			}
			defer cancel()
			if !deadline {
				cancelAfterFollow <- cancel
			}
			followed := false
			err := NewDesktopObserver(path).subscribeDesktopTarget(ctx, "session", "owner", func() { followed = true }, func(protocol.DesktopObservation) {})
			if !followed || !errors.Is(err, want) || errors.Is(err, io.EOF) {
				t.Fatalf("transport error replaced the cancellation cause: %v", err)
			}
			class := "context-canceled"
			if deadline {
				class = "context-deadline"
			}
			logDesktopSubscriptionFailure(err)
			assertDesktopSubscriptionLog(t, output.String(), "subscription-window-ended", "attempt", class, false)
		})
	}
}

func TestDesktopSubscriptionDiagnosticsCanceledWatchDoesNotLogFailure(t *testing.T) {
	output := captureDesktopSubscriptionLogs(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	path, waitIdle := isolationFixture(t, func(c *desktopConn, id string) error {
		cancel()
		return isolationUnfollowOrClose(c, id)
	})
	err := NewDesktopObserver(path).Watch(ctx, []string{"session"}, func(string, protocol.DesktopObservation) {})
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	waitIdle()
	if output.Len() != 0 {
		t.Fatalf("normal Watch cancellation emitted a failure: %q", output.String())
	}
}
