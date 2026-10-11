package codex

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const isolationWait = 2 * time.Second

// Every accepted connection gets a distinct identity. Discovery must remain
// unfollowed, and each follower is constrained to exactly one proven target.
func isolationFixture(t *testing.T, subscribe func(*desktopConn, string) error, ownerFilters ...func(string) bool) (string, func()) {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "desktop-isolation-")
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
	var mu sync.Mutex
	connections := map[net.Conn]bool{}
	var failures []error
	var workers sync.WaitGroup
	var sequence atomic.Int32
	acceptedDone := make(chan struct{})
	go func() {
		defer close(acceptedDone)
		for {
			connection, acceptErr := listener.Accept()
			if acceptErr != nil {
				if !errors.Is(acceptErr, net.ErrClosed) {
					mu.Lock()
					failures = append(failures, acceptErr)
					mu.Unlock()
				}
				return
			}
			mu.Lock()
			connections[connection] = true
			mu.Unlock()
			workers.Add(1)
			clientID := fmt.Sprintf("isolation-client-%d", sequence.Add(1))
			go func() {
				defer workers.Done()
				defer func() {
					closeErr := connection.Close()
					mu.Lock()
					delete(connections, connection)
					if closeErr != nil && !errors.Is(closeErr, net.ErrClosed) {
						failures = append(failures, closeErr)
					}
					mu.Unlock()
				}()
				handleErr := connection.SetDeadline(time.Now().Add(desktopTestTimeout))
				if handleErr == nil {
					handleErr = isolationConnection(&desktopConn{Conn: connection, clientID: clientID}, subscribe, ownerFilters)
				}
				if handleErr != nil && !errors.Is(handleErr, io.EOF) && !errors.Is(handleErr, net.ErrClosed) &&
					!errors.Is(handleErr, syscall.EPIPE) && !errors.Is(handleErr, syscall.ECONNRESET) {
					mu.Lock()
					failures = append(failures, handleErr)
					mu.Unlock()
				}
			}()
		}
	}()
	waitIdle := func() {
		t.Helper()
		deadline := time.NewTimer(isolationWait)
		defer deadline.Stop()
		tick := time.NewTicker(time.Millisecond)
		defer tick.Stop()
		for {
			mu.Lock()
			count := len(connections)
			mu.Unlock()
			if count == 0 {
				return
			}
			select {
			case <-tick.C:
			case <-deadline.C:
				t.Fatalf("observer retained %d fixture connections", count)
			}
		}
	}
	t.Cleanup(func() {
		if closeErr := listener.Close(); closeErr != nil && !errors.Is(closeErr, net.ErrClosed) {
			t.Error(closeErr)
		}
		<-acceptedDone
		mu.Lock()
		for connection := range connections {
			if closeErr := connection.Close(); closeErr != nil && !errors.Is(closeErr, net.ErrClosed) {
				failures = append(failures, closeErr)
			}
		}
		mu.Unlock()
		workers.Wait()
		for _, failure := range failures {
			t.Errorf("isolated desktop fixture: %v", failure)
		}
		if cleanupErr := os.RemoveAll(dir); cleanupErr != nil {
			t.Error(cleanupErr)
		}
	})
	return path, waitIdle
}

func isolationConnection(c *desktopConn, subscribe func(*desktopConn, string) error, ownerFilters []func(string) bool) error {
	initialize, err := c.read()
	if err != nil {
		return err
	}
	if initialize.Type != "request" || initialize.Method != desktopInitialize || initialize.Version != 0 {
		return errors.New("unexpected isolated initialization")
	}
	if err := desktopReply(c, initialize, c.clientID, map[string]string{"clientId": c.clientID}); err != nil {
		return err
	}
	discoveryConnection := false
	for {
		message, err := c.read()
		if err != nil {
			return err
		}
		var params struct {
			ConversationID string `json:"conversationId"`
			HostID         string `json:"hostId"`
			Following      bool   `json:"following"`
		}
		if err := json.Unmarshal(message.Params, &params); err != nil {
			return err
		}
		if params.HostID != "local" || params.ConversationID == "" || message.SourceClientID != c.clientID {
			return errors.New("isolated request identity mismatch")
		}
		switch message.Method {
		case desktopDiscoverOwner:
			discoveryConnection = true
			if message.Type != "request" || message.Version != 1 {
				return errors.New("invalid isolated discovery")
			}
			if len(ownerFilters) > 0 && !ownerFilters[0](params.ConversationID) {
				if err := c.write(desktopEnvelope{Type: "response", RequestID: message.RequestID, Method: message.Method, ResultType: "error"}); err != nil {
					return err
				}
				continue
			}
			if err := desktopReply(c, message, "owner-"+params.ConversationID, nil); err != nil {
				return err
			}
		case desktopFollowingChanged:
			if discoveryConnection {
				return errors.New("shared discovery connection subscribed to a snapshot")
			}
			if message.Type != "broadcast" || message.Version != 1 || !params.Following ||
				len(message.TargetClientIDs) != 1 || message.TargetClientIDs[0] != "owner-"+params.ConversationID {
				return errors.New("isolated subscription did not use exact discovered owner")
			}
			return subscribe(c, params.ConversationID)
		default:
			return fmt.Errorf("unexpected isolated method %q", message.Method)
		}
	}
}

func isolationState(c *desktopConn, id, owner string, change map[string]any) error {
	message, err := desktopAnySessionEnvelope(id, owner, change)
	if err != nil {
		return err
	}
	message.TargetClientIDs = []string{c.clientID}
	return c.write(message)
}

func isolationSnapshot(c *desktopConn, id string) error {
	return isolationState(c, id, "owner-"+id, map[string]any{"type": "snapshot", "revision": 1,
		"conversationState": map[string]any{"id": id, "hostId": "local", "threadRuntimeStatus": map[string]string{"type": "active"}}})
}

func isolationUnfollowOrClose(c *desktopConn, id string) error {
	for {
		message, err := c.read()
		if err != nil {
			return err
		}
		var params struct {
			ConversationID string `json:"conversationId"`
			Following      bool   `json:"following"`
		}
		if err := json.Unmarshal(message.Params, &params); err != nil {
			return err
		}
		if message.Method != desktopFollowingChanged || params.ConversationID != id || params.Following {
			return errors.New("subscription connection followed a second target or issued a non-read-only operation")
		}
	}
}

func TestDesktopSubscriptionIsolationBadTargetPreservesHealthyStream(t *testing.T) {
	for _, failure := range []string{"oversized", "wrong-owner", "revision-gap"} {
		t.Run(failure, func(t *testing.T) {
			badRevoked := make(chan struct{})
			var badSubscriptions atomic.Int32
			var badClosed sync.Once
			path, waitIdle := isolationFixture(t, func(c *desktopConn, id string) error {
				if id == "bad" {
					badSubscriptions.Add(1)
					defer badClosed.Do(func() { close(badRevoked) })
					if failure == "oversized" {
						var header [4]byte
						binary.LittleEndian.PutUint32(header[:], desktopInboundFrameLimit+1)
						if _, err := c.Write(header[:]); err != nil {
							return err
						}
					} else {
						if err := isolationSnapshot(c, id); err != nil {
							return err
						}
						owner, base := "owner-bad", uint64(1)
						if failure == "wrong-owner" {
							owner = "wrong-owner"
						} else {
							base = 9
						}
						if err := isolationState(c, id, owner, desktopPatchChange(base, base+1)); err != nil {
							return err
						}
					}
					return isolationUnfollowOrClose(c, id)
				}
				if err := isolationSnapshot(c, id); err != nil {
					return err
				}
				select {
				case <-badRevoked:
				case <-time.After(isolationWait):
					return errors.New("bad target was not independently revoked")
				}
				if err := isolationState(c, id, "owner-"+id, desktopPatchChange(1, 2,
					map[string]any{"op": "replace", "path": []any{"threadRuntimeStatus", "type"}, "value": "idle"})); err != nil {
					return err
				}
				return isolationUnfollowOrClose(c, id)
			})
			observer := NewDesktopObserver(path)
			ctx, cancel := context.WithTimeout(context.Background(), isolationWait)
			defer cancel()
			var callbackActive atomic.Int32
			var badLive, healthyLive, healthyLost, healthyAdvanced bool
			err := observer.Watch(ctx, []string{"bad", "healthy"}, func(id string, observation protocol.DesktopObservation) {
				if !callbackActive.CompareAndSwap(0, 1) {
					t.Error("publication callbacks overlap")
				}
				defer callbackActive.Store(0)
				runtime.Gosched()
				if id == "bad" {
					badLive = badLive || observation.Availability == "available"
					return
				}
				if healthyLive && observation.Availability != "available" && ctx.Err() == nil {
					healthyLost = true
				}
				healthyLive = healthyLive || observation.Availability == "available"
				if observation.Status == "idle" && observation.Availability == "available" && observation.Revision == 2 {
					healthyAdvanced = true
					cancel()
				}
			})
			if !errors.Is(err, context.Canceled) || !healthyAdvanced || healthyLost || failure == "oversized" && badLive || badSubscriptions.Load() != 1 {
				t.Fatalf("bad target contaminated healthy stream: err=%v advanced=%v lost=%v badLive=%v attempts=%d", err, healthyAdvanced, healthyLost, badLive, badSubscriptions.Load())
			}
			waitIdle()
		})
	}
}

func TestDesktopSubscriptionIsolationBoundedFollowersAndCancellation(t *testing.T) {
	started := make(chan string, 8)
	path, waitIdle := isolationFixture(t, func(c *desktopConn, id string) error {
		started <- id
		if err := isolationSnapshot(c, id); err != nil {
			return err
		}
		return isolationUnfollowOrClose(c, id)
	})
	observer := NewDesktopObserver(path)
	observer.watchWindow, observer.subscriptionWindow = time.Second, time.Second
	observer.subscriptionLimit = 2
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- observer.Watch(ctx, []string{"a", "b", "c", "d"}, func(string, protocol.DesktopObservation) {})
	}()
	for range 2 {
		select {
		case <-started:
		case <-time.After(isolationWait):
			t.Fatal("two independent subscription slots did not start")
		}
	}
	select {
	case id := <-started:
		t.Fatalf("subscription concurrency exceeded two while slots remain live: %s", id)
	case <-time.After(40 * time.Millisecond):
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled isolated watch returned %v", err)
		}
	case <-time.After(isolationWait):
		t.Fatal("isolated watcher did not join cancellation")
	}
	waitIdle()
}

func TestDesktopSubscriptionIsolationFairActualStartsAcrossWindows(t *testing.T) {
	var mu sync.Mutex
	follows := map[string]int{}
	path, waitIdle := isolationFixture(t, func(c *desktopConn, id string) error {
		mu.Lock()
		follows[id]++
		mu.Unlock()
		if err := isolationSnapshot(c, id); err != nil {
			return err
		}
		return isolationUnfollowOrClose(c, id)
	})
	observer := NewDesktopObserver(path)
	observer.watchWindow, observer.subscriptionWindow = 80*time.Millisecond, 50*time.Millisecond
	observer.subscriptionLimit = 2
	ids := []string{"a", "b", "c", "d", "e", "f", "g"}
	for round := range 4 {
		ctx, cancel := context.WithTimeout(context.Background(), isolationWait)
		err := observer.Watch(ctx, ids, func(string, protocol.DesktopObservation) {})
		cancel()
		if err != nil {
			t.Fatalf("window %d failed: %v", round, err)
		}
		waitIdle()
	}
	mu.Lock()
	defer mu.Unlock()
	for _, id := range ids {
		if follows[id] == 0 {
			t.Fatalf("discovery advanced without fairly starting target %s: %+v", id, follows)
		}
	}
}

func TestDesktopSubscriptionIsolationKnownOwnersFairWithoutWithinWindowRotation(t *testing.T) {
	var mu sync.Mutex
	follows := map[string]int{}
	path, waitIdle := isolationFixture(t, func(c *desktopConn, id string) error {
		mu.Lock()
		follows[id]++
		mu.Unlock()
		if err := isolationSnapshot(c, id); err != nil {
			return err
		}
		return isolationUnfollowOrClose(c, id)
	}, func(string) bool {
		// Stagger ordered proofs so an early response has time to occupy a slot.
		// Subscription fairness must not depend on all proofs arriving together.
		const proofSpacing = 5 * time.Millisecond
		timer := time.NewTimer(proofSpacing)
		defer timer.Stop()
		<-timer.C
		return true
	})
	observer := NewDesktopObserver(path)
	observer.watchWindow, observer.subscriptionWindow = 80*time.Millisecond, 200*time.Millisecond
	observer.subscriptionLimit = 2
	ids := []string{"a", "b", "c", "d", "e", "f", "g"}
	for _, id := range ids {
		observer.discovery.observe(id, true)
		observer.subscriptions.observe(id, true)
	}
	for round := range 4 {
		err := observer.Watch(context.Background(), ids, func(string, protocol.DesktopObservation) {})
		if err != nil {
			t.Fatalf("known-owner window %d failed: %v", round, err)
		}
		waitIdle()
	}
	mu.Lock()
	defer mu.Unlock()
	for _, id := range ids {
		if follows[id] == 0 {
			t.Fatalf("early owner proofs bypassed known subscription queue for %s: %+v", id, follows)
		}
	}
}

func TestDesktopSubscriptionIsolationColdInventoryDoesNotRotateHealthyOwners(t *testing.T) {
	for _, ownerCount := range []int{1, 2} {
		t.Run(fmt.Sprintf("owners-%d", ownerCount), func(t *testing.T) {
			var mu sync.Mutex
			starts := map[string]int{}
			const slot = 40 * time.Millisecond
			path, waitIdle := isolationFixture(t, func(c *desktopConn, id string) error {
				mu.Lock()
				starts[id]++
				mu.Unlock()
				if err := isolationSnapshot(c, id); err != nil {
					return err
				}
				// Cross two nominal slots on the same transport. Cold candidates
				// cannot turn an uncontended owner into a periodically offline one.
				timer := time.NewTimer(3 * slot)
				defer timer.Stop()
				<-timer.C
				if err := isolationState(c, id, "owner-"+id, desktopPatchChange(1, 2,
					map[string]any{"op": "replace", "path": []any{"threadRuntimeStatus", "type"}, "value": "idle"})); err != nil {
					return err
				}
				return isolationUnfollowOrClose(c, id)
			}, func(id string) bool { return id == "healthy-0" || ownerCount == 2 && id == "healthy-1" })
			ids := make([]string, 0, 18)
			for index := range 18 - ownerCount {
				ids = append(ids, fmt.Sprintf("cold-%02d", index))
			}
			for index := range ownerCount {
				ids = append(ids, fmt.Sprintf("healthy-%d", index))
			}
			observer := NewDesktopObserver(path)
			observer.watchWindow, observer.subscriptionWindow = 300*time.Millisecond, slot
			ctx, cancel := context.WithTimeout(context.Background(), isolationWait)
			defer cancel()
			live, advanced := map[string]bool{}, map[string]bool{}
			lost := false
			err := observer.Watch(ctx, ids, func(id string, observation protocol.DesktopObservation) {
				if live[id] && observation.Availability != "available" && ctx.Err() == nil {
					lost = true
				}
				if observation.Availability == "available" {
					live[id] = true
					if observation.Revision == 2 {
						advanced[id] = true
						if len(advanced) == ownerCount {
							cancel()
						}
					}
				}
			})
			if !errors.Is(err, context.Canceled) || lost || len(advanced) != ownerCount {
				t.Fatalf("cold inventory interrupted healthy owners: err=%v lost=%v advanced=%v", err, lost, advanced)
			}
			waitIdle()
			mu.Lock()
			defer mu.Unlock()
			for id, count := range starts {
				if count != 1 {
					t.Errorf("uncontended owner %s was unnecessarily resubscribed %d times", id, count)
				}
			}
		})
	}
}

type isolationHeaderReader struct {
	net.Conn
	header [4]byte
	reads  int
}

func (r *isolationHeaderReader) Read(destination []byte) (int, error) {
	r.reads++
	if r.reads != 1 {
		return 0, errors.New("oversized frame attempted to read its body")
	}
	return copy(destination, r.header[:]), nil
}

func TestDesktopSubscriptionIsolationRejectsOversizedHeaderBeforeBodyAllocation(t *testing.T) {
	reader := &isolationHeaderReader{}
	binary.LittleEndian.PutUint32(reader.header[:], desktopInboundFrameLimit+1)
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	_, err := (&desktopConn{Conn: reader}).read()
	runtime.ReadMemStats(&after)
	const allocationAllowance = 1024 * 1024
	if !errors.Is(err, errDesktopFrameTooLarge) || reader.reads != 1 || after.TotalAlloc-before.TotalAlloc >= allocationAllowance {
		t.Fatalf("oversized header was not rejected before allocation/read: err=%v reads=%d allocated=%d", err, reader.reads, after.TotalAlloc-before.TotalAlloc)
	}
}
