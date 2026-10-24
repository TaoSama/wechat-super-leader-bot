package desktop

import (
	"context"
	"fmt"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestDesktopScheduleFairInBothLanesAndAllKnown(t *testing.T) {
	const count = 129
	for _, allKnown := range []bool{false, true} {
		t.Run(fmt.Sprintf("all-known=%v", allKnown), func(t *testing.T) {
			var schedule desktopDiscoverySchedule
			ids := make([]string, count)
			for i := range ids {
				ids[i] = fmt.Sprintf("session-%03d", i)
				if allKnown || i%2 == 0 {
					schedule.observe(ids[i], true)
				}
			}
			seen := map[string]bool{}
			for range count/desktopDiscoveryConcurrency + 2 {
				queue := schedule.targets(ids)
				if len(queue) != count {
					t.Fatal("inventory lost or duplicated")
				}
				for _, target := range queue[:desktopDiscoveryConcurrency] {
					seen[target.id] = true
					schedule.dispatched(target)
				}
			}
			if len(seen) != count {
				t.Fatalf("short windows starved %d sessions", count-len(seen))
			}
		})
	}
}

func TestDesktopScheduleRemovedCursorAndMembershipChanges(t *testing.T) {
	var schedule desktopDiscoverySchedule
	ids := []string{"a", "b", "c", "d", "e", "e"}
	queue := schedule.targets(ids)
	for _, target := range queue[:2] {
		schedule.dispatched(target)
	}
	ids = []string{"a", "c", "d", "e"} // Last dispatched b no longer exists.
	queue = schedule.targets(ids)
	if queue[0].id != "c" {
		t.Fatalf("deleted cursor reset progress: %+v", queue)
	}
	schedule.observe("c", true)
	queue = schedule.targets(ids)
	if queue[0] != (desktopDiscoveryTarget{id: "c", known: true}) || queue[1].id != "d" {
		t.Fatalf("lane transfer changed unseen progress: %+v", queue)
	}
	schedule.dispatched(queue[0])
	schedule.observe("d", true)
	queue = schedule.targets([]string{"a", "d", "e"})
	if queue[0].id != "d" || schedule.known["c"] {
		t.Fatalf("known lane deletion retained stale identity: %+v", queue)
	}
	schedule.observe("d", false)
	for _, target := range schedule.targets([]string{"a", "d", "e"}) {
		if target.known {
			t.Fatal("failed owner remained in known lane")
		}
	}
}

func TestDesktopWatchShortWindowsReachTailAndReobserveKnownOwners(t *testing.T) {
	const silentCount = 3 * desktopDiscoveryConcurrency
	ids := make([]string, 0, silentCount+2)
	for i := range silentCount {
		ids = append(ids, fmt.Sprintf("cold-%03d", i))
	}
	ids = append(ids, "known", "tail")
	observer := desktopObserverWithTimeout("", desktopTestTimeout)
	observer.watchWindow = 100 * time.Millisecond
	observer.discovery.observe("known", true)
	owners := map[string]string{"known": "owner-known", "tail": "owner-tail"}
	tailFound := false
	for round := range 5 {
		observer.socketPath = desktopWatchFixture(t, owners, func(c *desktopConn, id string) error {
			snapshot, err := desktopAnySessionSnapshot(id, owners[id], "active")
			if err != nil {
				return err
			}
			if err := c.write(snapshot); err != nil {
				return err
			}
			return desktopOnlyUnsubscribeUntilClosed(c, owners)
		})
		ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
		observed := map[string]bool{}
		err := observer.Watch(ctx, ids, func(id string, observation protocol.DesktopObservation) {
			observed[id] = observed[id] || observation.Availability == "available"
		})
		cancel()
		if err != nil || !observed["known"] {
			t.Fatalf("round %d lost known owner: %+v, %v", round, observed, err)
		}
		if tailFound && !observed["tail"] {
			t.Fatalf("round %d did not renew the newly found owner", round)
		}
		tailFound = tailFound || observed["tail"]
	}
	if !tailFound {
		t.Fatal("silent prefix permanently starved tail owner")
	}
}

func TestDesktopSnapshotDoesNotChangeWatchScheduleAndFailedConnectDoesNotAdvance(t *testing.T) {
	observer := NewDesktopObserver(filepath.Join(t.TempDir(), "missing.sock"))
	observer.discovery.observe("known", true)
	observer.discovery.dispatched(desktopDiscoveryTarget{id: "b"})
	ids := []string{"a", "b", "known"}
	before := observer.discovery.targets(ids)
	if err := observer.Watch(context.Background(), ids, func(string, protocol.DesktopObservation) {}); err == nil {
		t.Fatal("missing socket accepted")
	}
	if !reflect.DeepEqual(before, observer.discovery.targets(ids)) {
		t.Fatal("failed connection advanced unsent requests")
	}
	observer.socketPath = desktopFixture(t, func(c *desktopConn) error {
		if err := desktopHandshake(c); err != nil {
			return err
		}
		requests, err := desktopDiscoveryRequests(c, len(ids))
		if err != nil {
			return err
		}
		for _, request := range requests {
			if err := c.write(desktopEnvelope{Type: "response", RequestID: request.RequestID, ResultType: "error"}); err != nil {
				return err
			}
		}
		return desktopExpectClosed(c)
	})
	ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
	defer cancel()
	if err := observer.Snapshot(ctx, ids, func(string, protocol.DesktopObservation) {}); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, observer.discovery.targets(ids)) {
		t.Fatal("one-shot snapshot changed long-running discovery progress")
	}
}
