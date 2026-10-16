package desktop

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestDesktopSubscriptionFreeCapacityDoesNotRotateForDiscoveryGate(t *testing.T) {
	const slot = 20 * time.Millisecond
	owners := map[string]string{"a": "owner-a", "b": "owner-b", "c": "owner-c"}
	aAvailable := make(chan struct{}, 1)
	path := desktopWatchFixture(t, owners, func(c *desktopConn, id string) error {
		snapshot, err := desktopAnySessionSnapshot(id, owners[id], "idle")
		if err != nil {
			return err
		}
		if err := c.write(snapshot); err != nil {
			return err
		}
		return desktopOnlyUnsubscribeUntilClosed(c, owners)
	}, func(c *desktopConn, first desktopEnvelope) error {
		requests, err := desktopDiscoveryWithFirst(c, first, len(owners))
		if err != nil {
			return err
		}
		for _, id := range []string{"a", "c"} {
			if err := desktopReply(c, requests[id], owners[id], nil); err != nil {
				return err
			}
		}
		select {
		case <-aAvailable:
		case <-time.After(desktopTestTimeout):
			return errors.New("first owner never became available")
		}
		timer := time.NewTimer(3 * slot)
		defer timer.Stop()
		<-timer.C
		if err := desktopReply(c, requests["b"], owners["b"], nil); err != nil {
			return err
		}
		return desktopExpectClosed(c)
	})
	observer := NewDesktopObserver(path)
	observer.subscriptionWindow = slot
	for id := range owners {
		observer.subscriptions.observe(id, true)
	}
	ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
	defer cancel()
	available := map[string]bool{}
	lost := false
	err := observer.Watch(ctx, []string{"a", "b", "c"}, func(id string, observation protocol.DesktopObservation) {
		if observation.Availability != "available" {
			if available[id] && ctx.Err() == nil {
				lost = true
			}
			return
		}
		if id == "a" && !available[id] {
			aAvailable <- struct{}{}
		}
		available[id] = true
		if len(available) == len(owners) {
			cancel()
		}
	})
	if !errors.Is(err, context.Canceled) || lost || len(available) != len(owners) {
		t.Fatalf("free slots caused healthy eviction behind discovery gate: err=%v lost=%v available=%v", err, lost, available)
	}
}

func TestDesktopDiscoveryRejectsOnlyCorrelatedInvalidTarget(t *testing.T) {
	for _, wrongMethod := range []bool{false, true} {
		t.Run(map[bool]string{false: "owner", true: "method"}[wrongMethod], func(t *testing.T) {
			owners := map[string]string{"bad": "owner-bad", "healthy": "owner-healthy"}
			path := desktopWatchFixture(t, owners, func(c *desktopConn, id string) error {
				if id != "healthy" {
					return errors.New("invalid target obtained a subscription")
				}
				snapshot, err := desktopAnySessionSnapshot(id, owners[id], "idle")
				if err != nil {
					return err
				}
				if err := c.write(snapshot); err != nil {
					return err
				}
				return desktopOnlyUnsubscribeUntilClosed(c, owners)
			}, func(c *desktopConn, first desktopEnvelope) error {
				requests, err := desktopDiscoveryWithFirst(c, first, 2)
				if err != nil {
					return err
				}
				bad, owner := requests["bad"], ""
				if wrongMethod {
					bad.Method, owner = "unexpected-method", owners["bad"]
				}
				if err := desktopReply(c, bad, owner, nil); err != nil {
					return err
				}
				if err := desktopReply(c, requests["healthy"], owners["healthy"], nil); err != nil {
					return err
				}
				return desktopExpectClosed(c)
			})
			observer := NewDesktopObserver(path)
			for id := range owners {
				observer.subscriptions.observe(id, true)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			unavailable, healthy := false, false
			err := observer.Watch(ctx, []string{"bad", "healthy"}, func(id string, observation protocol.DesktopObservation) {
				if id == "bad" {
					if observation.OwnerID != "" || observation.Availability != "unavailable" {
						t.Errorf("invalid target acquired authority: %+v", observation)
					}
					unavailable = true
				}
				if id == "healthy" && observation.Availability == "available" {
					healthy = true
					cancel()
				}
			})
			if !errors.Is(err, context.Canceled) || !unavailable || !healthy {
				t.Fatalf("correlated discovery failure poisoned healthy target: err=%v bad=%v healthy=%v", err, unavailable, healthy)
			}
		})
	}
}

func TestDesktopSnapshotKeepsPartialObservationAndFrameError(t *testing.T) {
	owners := map[string]string{"healthy": "owner-healthy", "oversized": "owner-oversized"}
	path := desktopFixture(t, func(c *desktopConn) error {
		if err := desktopHandshake(c); err != nil {
			return err
		}
		requests, err := desktopDiscoveryRequests(c, 2)
		if err != nil {
			return err
		}
		if err := desktopReplyAndSnapshot(c, requests["healthy"], "healthy", owners["healthy"]); err != nil {
			return err
		}
		if err := desktopReply(c, requests["oversized"], owners["oversized"], nil); err != nil {
			return err
		}
		if err := desktopReadFollow(c, "oversized", owners["oversized"], true); err != nil {
			return err
		}
		var header [4]byte
		binary.LittleEndian.PutUint32(header[:], uint32(desktopInboundFrameLimit+1))
		if _, err := io.Copy(c, bytes.NewReader(header[:])); err != nil {
			return err
		}
		return desktopOnlyUnsubscribeUntilClosed(c, owners)
	})
	ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
	defer cancel()
	observed := make(map[string]protocol.DesktopObservation)
	err := NewDesktopObserver(path).Snapshot(ctx, []string{"healthy", "oversized"}, func(id string, observation protocol.DesktopObservation) {
		observed[id] = observation
	})
	if !errors.Is(err, errDesktopFrameTooLarge) || len(observed) != 1 || observed["healthy"].Availability != "available" {
		t.Fatalf("partial snapshot became complete or lost error: err=%v observed=%+v", err, observed)
	}
}
