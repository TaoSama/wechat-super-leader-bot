package desktop

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type budgetReadSpy struct {
	net.Conn
	headerRead chan struct{}
	bodyRead   chan struct{}
	reads      int
}

func (c *budgetReadSpy) Read(destination []byte) (int, error) {
	c.reads++
	if c.reads == 2 {
		close(c.bodyRead)
	}
	n, err := c.Conn.Read(destination)
	if c.reads == 1 {
		close(c.headerRead)
	}
	return n, err
}

func budgetPipe(t *testing.T, size int) (*desktopConn, net.Conn, *budgetReadSpy) {
	t.Helper()
	client, server := net.Pipe()
	spy := &budgetReadSpy{Conn: client, headerRead: make(chan struct{}), bodyRead: make(chan struct{})}
	written := make(chan error, 1)
	go func() {
		var header [4]byte
		binary.LittleEndian.PutUint32(header[:], uint32(size))
		_, err := server.Write(header[:])
		written <- err
	}()
	t.Cleanup(func() {
		for _, connection := range []net.Conn{client, server} {
			if err := connection.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
				t.Error(err)
			}
		}
		if err := <-written; err != nil && !errors.Is(err, io.ErrClosedPipe) {
			t.Error(err)
		}
	})
	return &desktopConn{Conn: spy, clientID: "budget-client"}, server, spy
}

func budgetAwait(t *testing.T, signal <-chan struct{}, reason string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(isolationWait):
		t.Fatal(reason)
	}
}

func budgetResult(t *testing.T, done <-chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(isolationWait):
		t.Fatal("budget worker did not join")
		return nil
	}
}

func TestDesktopSubscriptionBudgetNineOwnersRemainLiveAcrossSlots(t *testing.T) {
	const owners = 9
	const slot = 40 * time.Millisecond
	var mu sync.Mutex
	starts := map[string]int{}
	path, waitIdle := isolationFixture(t, func(c *desktopConn, id string) error {
		mu.Lock()
		starts[id]++
		mu.Unlock()
		if err := isolationSnapshot(c, id); err != nil {
			return err
		}
		timer := time.NewTimer(3 * slot)
		defer timer.Stop()
		<-timer.C
		if err := isolationState(c, id, "owner-"+id, desktopPatchChange(1, 2,
			map[string]any{"op": "replace", "path": []any{"threadRuntimeStatus", "type"}, "value": "idle"})); err != nil {
			return err
		}
		return isolationUnfollowOrClose(c, id)
	})
	ids := make([]string, owners)
	for index := range owners {
		ids[index] = fmt.Sprintf("healthy-%d", index)
	}
	observer := NewDesktopObserver(path)
	observer.watchWindow, observer.subscriptionWindow = 400*time.Millisecond, slot
	ctx, cancel := context.WithTimeout(context.Background(), isolationWait)
	defer cancel()
	live, advanced := map[string]bool{}, map[string]bool{}
	lost, peak := false, 0
	err := observer.Watch(ctx, ids, func(id string, observation protocol.DesktopObservation) {
		if observation.Availability != "available" {
			if live[id] && ctx.Err() == nil {
				lost = true
			}
			delete(live, id)
			return
		}
		live[id] = true
		peak = max(peak, len(live))
		if observation.Revision == 2 {
			advanced[id] = true
			if len(advanced) == owners {
				cancel()
			}
		}
	})
	if !errors.Is(err, context.Canceled) || lost || peak != owners || len(advanced) != owners {
		t.Fatalf("nine-owner coverage was time-sliced: err=%v lost=%v peak=%d advanced=%v", err, lost, peak, advanced)
	}
	waitIdle()
	mu.Lock()
	defer mu.Unlock()
	for _, id := range ids {
		if starts[id] != 1 {
			t.Errorf("healthy owner %s followed %d times", id, starts[id])
		}
	}
}

func TestDesktopSubscriptionBudgetSlowBodiesBoundHealthyRecovery(t *testing.T) {
	const bodyTimeout = 200 * time.Millisecond
	startedAt := time.Now()
	budget := newDesktopFrameBudget(2, bodyTimeout)
	ctx, cancel := context.WithTimeout(context.Background(), isolationWait)
	defer cancel()
	slowDone := make([]chan error, 2)
	for index := range 2 {
		c, _, spy := budgetPipe(t, 16)
		slowDone[index] = make(chan error, 1)
		go func() { slowDone[index] <- c.readBudgeted(ctx, budget, func(desktopEnvelope) error { return nil }) }()
		budgetAwait(t, spy.bodyRead, "slow body did not acquire its frame slot")
	}
	message, err := desktopAnySessionEnvelope("healthy", "owner-healthy", desktopPatchChange(1, 2,
		map[string]any{"op": "replace", "path": []any{"threadRuntimeStatus", "type"}, "value": "idle"}))
	if err != nil {
		t.Fatal(err)
	}
	message.TargetClientIDs = []string{"budget-client"}
	body, err := json.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	const bodySize = 1024 * 1024
	body = append(body, bytes.Repeat([]byte(" "), bodySize-len(body))...)
	c, server, spy := budgetPipe(t, len(body))
	projection := &desktopProjection{owner: "owner-healthy", initialized: true, revision: 1, status: "active"}
	advanced := false
	done := make(chan error, 1)
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	go func() {
		done <- c.readBudgeted(ctx, budget, func(envelope desktopEnvelope) error {
			return applyDesktopChange(envelope, c.clientID, map[string]*desktopProjection{"healthy": projection},
				func(_ string, observation protocol.DesktopObservation) {
					advanced = observation.Revision == 2 && observation.Status == "idle"
				})
		})
	}()
	budgetAwait(t, spy.headerRead, "healthy header did not remain outside the frame budget")
	select {
	case <-spy.bodyRead:
		t.Fatal("third frame read a body while both slots were occupied")
	case <-time.After(25 * time.Millisecond):
	}
	runtime.ReadMemStats(&after)
	const allocationAllowance = 512 * 1024
	if allocated := after.TotalAlloc - before.TotalAlloc; allocated >= allocationAllowance {
		t.Fatalf("third frame allocated its body before acquiring a slot: %d bytes", allocated)
	}
	written := make(chan error, 1)
	go func() { _, err := server.Write(body); written <- err }()
	if err := budgetResult(t, done); err != nil || !advanced {
		t.Fatalf("healthy patch did not resume after slow-body expiration: err=%v advanced=%v", err, advanced)
	}
	if elapsed := time.Since(startedAt); elapsed > 4*bodyTimeout {
		t.Fatalf("slow bodies delayed healthy recovery beyond the bounded deadline: %v", elapsed)
	}
	if err := budgetResult(t, written); err != nil {
		t.Fatal(err)
	}
	for _, result := range slowDone {
		var timeout net.Error
		if err := budgetResult(t, result); !errors.As(err, &timeout) || !timeout.Timeout() {
			t.Fatalf("slow body did not expire independently: %v", err)
		}
	}
	if len(budget.slots) != 0 {
		t.Fatal("body timeout or healthy projection leaked a frame permit")
	}
}

func TestDesktopSubscriptionBudgetOversizedHeaderBypassesOccupiedSlots(t *testing.T) {
	budget := newDesktopFrameBudget(2, time.Second)
	for range 2 {
		if err := budget.acquire(context.Background()); err != nil {
			t.Fatal(err)
		}
		defer budget.release()
	}
	reader := &isolationHeaderReader{}
	binary.LittleEndian.PutUint32(reader.header[:], desktopInboundFrameLimit+1)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	err := (&desktopConn{Conn: reader}).readBudgeted(ctx, budget, func(desktopEnvelope) error {
		t.Error("oversized header reached projection")
		return nil
	})
	if !errors.Is(err, errDesktopFrameTooLarge) || reader.reads != 1 || len(budget.slots) != 2 {
		t.Fatalf("oversized header waited for or consumed a permit: err=%v reads=%d slots=%d", err, reader.reads, len(budget.slots))
	}
}

func TestDesktopSubscriptionBudgetCancellationAndProjectionLifetime(t *testing.T) {
	budget := newDesktopFrameBudget(1, time.Second)
	c, server, projectionSpy := budgetPipe(t, 2)
	entered, finish := make(chan struct{}), make(chan struct{})
	var finishOnce sync.Once
	defer finishOnce.Do(func() { close(finish) })
	done, written := make(chan error, 1), make(chan error, 1)
	go func() {
		<-projectionSpy.headerRead
		_, err := server.Write([]byte("{}"))
		written <- err
	}()
	projectionFailure := errors.New("invalid synthetic projection")
	go func() {
		done <- c.readBudgeted(context.Background(), budget, func(desktopEnvelope) error {
			close(entered)
			<-finish
			return projectionFailure
		})
	}()
	budgetAwait(t, entered, "projection callback did not start")
	if len(budget.slots) != 1 {
		t.Fatal("frame permit was released before projection completed")
	}
	ctx, cancel := context.WithCancel(context.Background())
	blocked, _, spy := budgetPipe(t, 16)
	waiter := make(chan error, 1)
	go func() { waiter <- blocked.readBudgeted(ctx, budget, func(desktopEnvelope) error { return nil }) }()
	budgetAwait(t, spy.headerRead, "canceled waiter did not reach the budget")
	cancel()
	if err := budgetResult(t, waiter); !errors.Is(err, context.Canceled) {
		t.Fatalf("budget waiter ignored cancellation: %v", err)
	}
	select {
	case <-spy.bodyRead:
		t.Fatal("canceled budget waiter attempted to read a body")
	default:
	}
	finishOnce.Do(func() { close(finish) })
	if err := budgetResult(t, done); !errors.Is(err, projectionFailure) {
		t.Fatalf("projection failure was lost: %v", err)
	}
	if err := budgetResult(t, written); err != nil {
		t.Fatal(err)
	}
	if len(budget.slots) != 0 {
		t.Fatal("canceled waiter or rejected projection leaked a permit")
	}
}

func TestDesktopSubscriptionBudgetInitializeCannotBypassOccupiedSlots(t *testing.T) {
	initialized := make(chan struct{}, 1)
	initializeReply := make(chan struct{})
	var replyOnce sync.Once
	defer replyOnce.Do(func() { close(initializeReply) })
	path := desktopConnectionsFixture(t, func(c *desktopConn) error {
		initialize, err := c.read()
		if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
			return nil
		}
		if err != nil {
			return err
		}
		if initialize.Method != desktopInitialize {
			return errors.New("budget fixture expected initialization")
		}
		initialized <- struct{}{}
		<-initializeReply
		c.clientID = "budget-init-client"
		if err := desktopReply(c, initialize, c.clientID, map[string]string{"clientId": c.clientID}); err != nil {
			return err
		}
		follow, err := c.read()
		if err != nil {
			return err
		}
		if follow.Method != desktopFollowingChanged {
			return errors.New("budget fixture received a non-read-only method")
		}
		if err := isolationSnapshot(c, "a"); err != nil {
			return err
		}
		err = isolationUnfollowOrClose(c, "a")
		if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
			return nil
		}
		return err
	}, true)
	observer := NewDesktopObserver(path)
	budget := observer.frameBudget
	for range 2 {
		if err := budget.acquire(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	// Release whichever manually acquired permits remain on an early failure.
	manualPermits := 2
	defer func() {
		for range manualPermits {
			budget.release()
		}
	}()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	available := make(chan struct{}, 1)
	go func() {
		done <- observer.subscribeDesktopTarget(ctx, "a", "owner-a", func() {}, func(observation protocol.DesktopObservation) {
			if observation.Availability == "available" {
				available <- struct{}{}
				// Scalar delivery may block, but it must not retain a raw-frame slot.
				<-ctx.Done()
			}
		})
	}()
	select {
	case <-initialized:
		t.Fatal("subscriber initialized while both frame permits were occupied")
	case <-time.After(25 * time.Millisecond):
	}
	budget.release()
	manualPermits--
	budgetAwait(t, initialized, "initialization did not resume after a frame permit was released")
	if len(budget.slots) != 2 {
		t.Fatal("incomplete initialize handshake did not retain its frame permit")
	}
	replyOnce.Do(func() { close(initializeReply) })
	budgetAwait(t, available, "initialized subscriber did not publish its snapshot")
	if len(budget.slots) != manualPermits {
		t.Fatal("blocked scalar publication retained a frame permit")
	}
	cancel()
	if err := budgetResult(t, done); !errors.Is(err, context.Canceled) {
		t.Fatalf("subscriber cancellation returned %v", err)
	}
	if len(budget.slots) != manualPermits {
		t.Fatalf("subscriber initialization leaked a permit: slots=%d manually held=%d", len(budget.slots), manualPermits)
	}
}

func TestDesktopSubscriptionBudgetBodyDeadlineDoesNotExtendOnTrickle(t *testing.T) {
	const bodyTimeout = 80 * time.Millisecond
	const trickleInterval = 20 * time.Millisecond
	budget := newDesktopFrameBudget(2, bodyTimeout)
	c, server, spy := budgetPipe(t, 16)
	written := make(chan error, 1)
	go func() {
		<-spy.headerRead
		ticker := time.NewTicker(trickleInterval)
		defer ticker.Stop()
		for range 16 {
			<-ticker.C
			if _, err := server.Write([]byte(" ")); err != nil {
				written <- err
				return
			}
		}
		written <- nil
	}()
	startedAt := time.Now()
	err := c.readBudgeted(context.Background(), budget, func(desktopEnvelope) error { return nil })
	var timeout net.Error
	if !errors.As(err, &timeout) || !timeout.Timeout() || time.Since(startedAt) > 3*bodyTimeout {
		t.Fatalf("body trickle extended an absolute deadline: err=%v elapsed=%v", err, time.Since(startedAt))
	}
	if err := server.Close(); err != nil {
		t.Fatal(err)
	}
	if err := budgetResult(t, written); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("trickle writer did not join its closed transport: %v", err)
	}
	if len(budget.slots) != 0 {
		t.Fatal("trickle timeout retained a frame permit")
	}
}

func TestDesktopSubscriptionBudgetConcurrentWatchesShareTwoSlots(t *testing.T) {
	releaseBodies := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(releaseBodies) })
	headers := make(chan struct{}, 4)
	path, waitIdle := isolationFixture(t, func(c *desktopConn, id string) error {
		if err := isolationSnapshot(c, id); err != nil {
			return err
		}
		<-releaseBodies
		var header [4]byte
		binary.LittleEndian.PutUint32(header[:], 16)
		if _, err := c.Write(header[:]); err != nil {
			return err
		}
		headers <- struct{}{}
		return isolationUnfollowOrClose(c, id)
	})
	observer := NewDesktopObserver(path)
	observer.watchWindow = time.Second
	observer.frameBudget = newDesktopFrameBudget(2, time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	available := make(chan struct{}, 4)
	done := make(chan error, 2)
	for _, ids := range [][]string{{"a", "b"}, {"c", "d"}} {
		go func() {
			done <- observer.Watch(ctx, ids, func(_ string, observation protocol.DesktopObservation) {
				if observation.Availability == "available" {
					available <- struct{}{}
				}
			})
		}()
	}
	for range 4 {
		budgetAwait(t, available, "both Watches did not initialize all four owners")
	}
	releaseOnce.Do(func() { close(releaseBodies) })
	for range 4 {
		budgetAwait(t, headers, "four independent frame headers did not arrive")
	}
	deadline := time.NewTimer(isolationWait)
	defer deadline.Stop()
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for len(observer.frameBudget.slots) != 2 {
		select {
		case <-tick.C:
		case <-deadline.C:
			t.Fatal("concurrent Watches did not use the same two frame slots")
		}
	}
	select {
	case <-done:
		t.Fatal("a stalled target prematurely stopped an entire Watch")
	case <-time.After(25 * time.Millisecond):
	}
	if len(observer.frameBudget.slots) != 2 {
		t.Fatal("concurrent Watches exceeded or abandoned the shared frame budget")
	}
	cancel()
	for range 2 {
		if err := budgetResult(t, done); !errors.Is(err, context.Canceled) {
			t.Fatalf("concurrent Watch cancellation returned %v", err)
		}
	}
	waitIdle()
	if len(observer.frameBudget.slots) != 0 {
		t.Fatal("concurrent Watch cancellation retained a frame permit")
	}
}
