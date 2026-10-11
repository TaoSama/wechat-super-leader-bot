package codex

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

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
