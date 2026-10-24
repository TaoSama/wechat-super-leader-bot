package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func desktopSubscriptionFollowing() desktopEnvelope {
	return desktopEnvelope{Type: "broadcast", Method: desktopFollowingChanged, Version: 1,
		SourceClientID: historyControlPeerID, TargetClientIDs: []string{"observer-client"},
		Params: json.RawMessage(`{"conversationId":"session","hostId":"local","following":false}`)}
}

func TestDesktopWatchInvalidatesRevokedSubscription(t *testing.T) {
	for _, method := range []string{desktopFollowingChanged, desktopClientStatusChanged} {
		t.Run(method, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), isolationWait)
			defer cancel()
			owners := map[string]string{"session": historyControlPeerID, "healthy": historyControlSourceID}
			ready, revoked, unfollowed := make(chan struct{}), make(chan struct{}), make(chan struct{})
			path := desktopWatchFixture(t, owners, func(c *desktopConn, id string) error {
				snapshot, err := desktopAnySessionSnapshot(id, owners[id], "idle")
				if err != nil {
					return err
				}
				if err := c.write(snapshot); err != nil {
					return err
				}
				if id == "session" {
					select {
					case <-ready:
					case <-ctx.Done():
						return nil
					}
					message := desktopSubscriptionFollowing()
					if method == desktopClientStatusChanged {
						message = historyControlStatus("disconnected")
					}
					if err := c.write(message); err != nil {
						return err
					}
					if err := desktopReadFollow(c, id, owners[id], false); err != nil {
						return err
					}
					close(unfollowed)
					return desktopExpectClosed(c)
				}
				select {
				case <-revoked:
				case <-ctx.Done():
					return nil
				}
				patch, err := desktopAnySessionEnvelope(id, owners[id], desktopPatchChange(1, 2,
					map[string]any{"op": "replace", "path": []any{"threadRuntimeStatus", "type"}, "value": "active"}))
				if err != nil {
					return err
				}
				if err := c.write(patch); err != nil {
					return err
				}
				return desktopOnlyUnsubscribeUntilClosed(c, owners)
			})
			observer := NewDesktopObserver(path)
			live := map[string]bool{}
			invalidated, advanced, healthyLost := false, false, false
			err := observer.Watch(ctx, []string{"session", "healthy"}, func(id string, observation protocol.DesktopObservation) {
				if observation.Availability == "available" {
					live[id] = true
					if len(live) == len(owners) {
						select {
						case <-ready:
						default:
							close(ready)
						}
					}
					if id == "healthy" && observation.Revision == 2 {
						advanced = true
						cancel()
					}
					return
				}
				if ctx.Err() != nil || !live[id] {
					return
				}
				if id == "healthy" {
					healthyLost = true
					return
				}
				if !invalidated && observation.Status == "unknown" && observation.OwnerID == owners[id] {
					invalidated = true
					close(revoked)
				}
			})
			if !errors.Is(err, context.Canceled) || !invalidated || !advanced || healthyLost {
				t.Fatalf("revocation did not promptly isolate target: err=%v invalidated=%v healthyAdvanced=%v healthyLost=%v", err, invalidated, advanced, healthyLost)
			}
			select {
			case <-unfollowed:
			case <-time.After(isolationWait):
				t.Fatal("revoked native follower was not removed")
			}
		})
	}
}

func TestDesktopWatchIgnoresUnrelatedSubscriptionLifecycle(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*desktopEnvelope)
	}{
		{"following wrong owner", func(m *desktopEnvelope) { m.SourceClientID = historyControlSourceID }},
		{"following wrong target", func(m *desktopEnvelope) { m.TargetClientIDs = []string{"other-client"} }},
		{"following missing target", func(m *desktopEnvelope) { m.TargetClientIDs = nil }},
		{"following wrong conversation", func(m *desktopEnvelope) {
			m.Params = json.RawMessage(`{"conversationId":"other","hostId":"local","following":false}`)
		}},
		{"following wrong host", func(m *desktopEnvelope) {
			m.Params = json.RawMessage(`{"conversationId":"session","hostId":"remote","following":false}`)
		}},
		{"following wrong version", func(m *desktopEnvelope) { m.Version = 2 }},
		{"following true", func(m *desktopEnvelope) {
			m.Params = json.RawMessage(`{"conversationId":"session","hostId":"local","following":true}`)
		}},
		{"following missing boolean", func(m *desktopEnvelope) {
			m.Params = json.RawMessage(`{"conversationId":"session","hostId":"local"}`)
		}},
		{"following null", func(m *desktopEnvelope) {
			m.Params = json.RawMessage(`{"conversationId":"session","hostId":"local","following":null}`)
		}},
		{"following duplicate", func(m *desktopEnvelope) {
			m.Params = json.RawMessage(`{"conversationId":"session","hostId":"local","following":true,"following":false}`)
		}},
		{"owner connected", func(m *desktopEnvelope) { *m = historyControlStatus("connected") }},
		{"owner unrelated", func(m *desktopEnvelope) {
			*m = historyControlStatus("disconnected")
			m.SourceClientID = historyControlSourceID
			m.Params = json.RawMessage(`{"clientId":"` + historyControlSourceID + `","clientType":"readonly","status":"disconnected"}`)
		}},
		{"owner source mismatch", func(m *desktopEnvelope) {
			*m = historyControlStatus("disconnected")
			m.SourceClientID = historyControlSourceID
		}},
		{"owner targeted", func(m *desktopEnvelope) {
			*m = historyControlStatus("disconnected")
			m.TargetClientIDs = []string{"observer-client"}
		}},
		{"owner wrong version", func(m *desktopEnvelope) {
			*m = historyControlStatus("disconnected")
			m.Version = 1
		}},
		{"owner duplicate", func(m *desktopEnvelope) {
			*m = historyControlStatus("disconnected")
			m.Params = json.RawMessage(`{"clientId":"` + historyControlPeerID + `","clientType":"readonly","status":"connected","status":"disconnected"}`)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			message := desktopSubscriptionFollowing()
			tc.change(&message)
			owners := map[string]string{"session": historyControlPeerID}
			path := desktopWatchFixture(t, owners, func(c *desktopConn, id string) error {
				snapshot, err := desktopAnySessionSnapshot(id, owners[id], "idle")
				if err != nil {
					return err
				}
				if err := c.write(snapshot); err != nil {
					return err
				}
				if err := c.write(message); err != nil {
					return err
				}
				patch, err := desktopAnySessionEnvelope(id, owners[id], desktopPatchChange(1, 2))
				if err != nil {
					return err
				}
				if err := c.write(patch); err != nil {
					return err
				}
				return desktopOnlyUnsubscribeUntilClosed(c, owners)
			})
			ctx, cancel := context.WithTimeout(context.Background(), isolationWait)
			defer cancel()
			live, advanced, lost := false, false, false
			err := NewDesktopObserver(path).Watch(ctx, []string{"session"}, func(_ string, observation protocol.DesktopObservation) {
				if observation.Availability == "available" {
					live = true
					if observation.Revision == 2 {
						advanced = true
						cancel()
					}
				} else if live && ctx.Err() == nil {
					lost = true
					cancel()
				}
			})
			if !errors.Is(err, context.Canceled) || !advanced || lost {
				t.Fatalf("unrelated lifecycle revoked subscription: err=%v advanced=%v lost=%v", err, advanced, lost)
			}
		})
	}
}
