package codex

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

func TestDesktopWatchPublishesOwnerBeforeOversizedSnapshot(t *testing.T) {
	proofPublished := make(chan struct{})
	path := desktopFixture(t, func(c *desktopConn) error {
		if err := desktopHandshake(c); err != nil {
			return err
		}
		requests, err := desktopDiscoveryRequests(c, 1)
		if err != nil {
			return err
		}
		if err := desktopReply(c, requests["session"], "owner", nil); err != nil {
			return err
		}
		select {
		case <-proofPublished:
		case <-time.After(desktopTestTimeout):
			return errors.New("discovery did not publish ownership before snapshot")
		}
		if err := desktopExpectFollow(c, true); err != nil {
			return err
		}
		// No body is needed: the observer must reject at the shared inbound bound.
		var header [4]byte
		binary.LittleEndian.PutUint32(header[:], uint32(desktopInboundFrameLimit+1))
		if _, err := io.Copy(c, bytes.NewReader(header[:])); err != nil {
			return err
		}
		if err := desktopExpectFollow(c, false); err != nil {
			return err
		}
		return desktopExpectClosed(c)
	})
	ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
	defer cancel()
	var observations []protocol.DesktopObservation
	err := NewDesktopObserver(path).Watch(ctx, []string{"session"}, func(id string, observation protocol.DesktopObservation) {
		if id != "session" {
			t.Errorf("ownership attached to wrong session: %q", id)
		}
		observations = append(observations, observation)
		if len(observations) == 1 {
			close(proofPublished)
		}
	})
	want := protocol.DesktopObservation{OwnerID: "owner", Status: "unknown", Availability: "unavailable", Source: "codex-desktop"}
	if !errors.Is(err, errDesktopFrameTooLarge) || len(observations) != 1 || observations[0] != want {
		t.Fatalf("bounded snapshot lost ownership or granted runtime facts: err=%v observations=%+v", err, observations)
	}
}

func TestDesktopWatchRejectsUnprovenDiscoveryOwner(t *testing.T) {
	for _, owner := range []string{"", "observer-client", "owner\u0085", "owner\ufffd", "owner with space"} {
		t.Run(owner, func(t *testing.T) {
			path := desktopFixture(t, func(c *desktopConn) error {
				if err := desktopHandshake(c); err != nil {
					return err
				}
				requests, err := desktopDiscoveryRequests(c, 1)
				if err != nil {
					return err
				}
				if err := desktopReply(c, requests["session"], owner, nil); err != nil {
					return err
				}
				return desktopExpectClosed(c)
			})
			ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
			defer cancel()
			published := false
			err := NewDesktopObserver(path).Watch(ctx, []string{"session"}, func(string, protocol.DesktopObservation) { published = true })
			if err == nil || published {
				t.Fatalf("invalid owner established desktop authority: err=%v published=%v", err, published)
			}
		})
	}
}

func TestDesktopWatchOwnershipWithoutSnapshotStaysUnavailable(t *testing.T) {
	path := desktopFixture(t, func(c *desktopConn) error {
		if err := desktopOwnerSubscribe(c); err != nil {
			return err
		}
		if err := desktopExpectFollow(c, false); err != nil {
			return err
		}
		return desktopExpectClosed(c)
	})
	observer := NewDesktopObserver(path)
	observer.watchWindow = desktopTestOwnerTimeout
	ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
	defer cancel()
	var observations []protocol.DesktopObservation
	err := observer.Watch(ctx, []string{"session"}, func(_ string, observation protocol.DesktopObservation) {
		observations = append(observations, observation)
	})
	if err != nil || len(observations) != 1 || observations[0].OwnerID != "owner" || observations[0].Availability != "unavailable" || observations[0].ObservedAt != "" {
		t.Fatalf("discovery became a fresh snapshot: err=%v observations=%+v", err, observations)
	}
}
