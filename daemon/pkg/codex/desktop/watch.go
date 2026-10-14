package desktop

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const desktopDiscoveryConcurrency = 32
const desktopDiscoveryTick = 100 * time.Millisecond

type desktopReadResult struct {
	message desktopEnvelope
	err     error
}

type desktopPendingOwner struct {
	id       string
	deadline time.Time
}

// A single reader owns framing for the entire subscription. Per-owner timeouts
// never interrupt a partially received frame or discard other sessions' updates.
func readDesktopEvents(ctx context.Context, c *desktopConn, events chan<- desktopReadResult, done chan<- struct{}) {
	defer close(done)
	for {
		message, err := c.read()
		select {
		case events <- desktopReadResult{message: message, err: err}:
		case <-ctx.Done():
			return
		}
		if err != nil {
			return
		}
	}
}

func (o *DesktopObserver) watch(ctx context.Context, ids []string, publish func(string, protocol.DesktopObservation), once bool) (err error) {
	queue, seen := []desktopDiscoveryTarget{}, map[string]bool{}
	for _, id := range ids {
		if !protocol.ValidHistoryIdentity(id) {
			return errors.New("invalid desktop session ID")
		}
		if !seen[id] {
			queue, seen[id] = append(queue, desktopDiscoveryTarget{id: id}), true
		}
	}
	if len(queue) == 0 {
		return nil
	}
	if !once {
		queue = o.discovery.targets(ids)
		forward := publish
		publish = func(id string, observation protocol.DesktopObservation) {
			o.discovery.observe(id, observation.Availability == "available")
			forward(id, observation)
		}
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	c, cleanup, err := connectDesktop(ctx, o.socketPath)
	if err != nil {
		return err
	}
	defer cleanup()
	if err := c.SetReadDeadline(time.Time{}); err != nil {
		return err
	}
	projections := map[string]*desktopProjection{}
	events, readerDone := make(chan desktopReadResult, 1), make(chan struct{})
	go readDesktopEvents(ctx, c, events, readerDone)
	defer func() {
		// Unsubscribe before cancel/close on normal completion. Cancellation also
		// removes the native follower by closing its connection.
		if ctx.Err() == nil {
			if deadlineErr := c.SetWriteDeadline(time.Now().Add(desktopUnsubscribeTimeout)); deadlineErr != nil {
				err = errors.Join(err, deadlineErr)
			} else {
				for id, projection := range projections {
					if unfollowErr := c.follow(projection.owner, id, false); unfollowErr != nil {
						err = errors.Join(err, fmt.Errorf("unsubscribe desktop observer: %w", unfollowErr))
						break
					}
				}
			}
		}
		cancel()
		cleanup()
		<-readerDone
	}()
	window := time.NewTimer(o.watchWindow)
	defer window.Stop()
	ticker := time.NewTicker(desktopDiscoveryTick)
	defer ticker.Stop()
	pending := map[string]desktopPendingOwner{}
	unavailable := func(id string) {
		publish(id, protocol.DesktopObservation{Status: "unknown", Availability: "unavailable", Source: "codex-desktop"})
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		for requestID, owner := range pending {
			if !time.Now().Before(owner.deadline) {
				delete(pending, requestID)
				unavailable(owner.id)
			}
		}
		for len(queue) > 0 && len(pending) < desktopDiscoveryConcurrency {
			target := queue[0]
			id := target.id
			queue = queue[1:]
			if err := c.SetWriteDeadline(time.Now().Add(desktopRequestTimeout)); err != nil {
				return err
			}
			requestID, err := c.sendRequest(desktopDiscoverOwner, 1, map[string]string{"hostId": "local", "conversationId": id})
			if err != nil {
				return err
			}
			if !once {
				o.discovery.dispatched(target)
			}
			pending[requestID] = desktopPendingOwner{id: id, deadline: time.Now().Add(o.ownerTimeout)}
		}
		if once && len(queue) == 0 && len(pending) == 0 {
			complete := true
			for _, p := range projections {
				complete = complete && p.initialized
			}
			if complete {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-window.C:
			if once {
				return errors.New("desktop snapshot timed out")
			}
			return nil
		case <-ticker.C:
		case event := <-events:
			if event.err != nil {
				return fmt.Errorf("read desktop subscription: %w", event.err)
			}
			message := event.message
			if message.Type != "response" {
				if err := applyDesktopChange(message, c.clientID, projections, publish); err != nil {
					return err
				}
				continue
			}
			owner, known := pending[message.RequestID]
			if !known {
				continue // Timed-out or unrelated response; never attach it to another session.
			}
			delete(pending, message.RequestID)
			if !time.Now().Before(owner.deadline) {
				unavailable(owner.id)
				continue
			}
			if message.ResultType == "error" {
				unavailable(owner.id)
				continue
			}
			if message.ResultType != "success" || message.Method != desktopDiscoverOwner {
				return errors.New("invalid desktop discovery response")
			}
			if !protocol.ValidHistoryIdentity(message.HandledByClientID) || !protocol.ValidTurnID(message.HandledByClientID) || message.HandledByClientID == c.clientID {
				return errors.New("invalid desktop owner identity")
			}
			projections[owner.id] = &desktopProjection{owner: message.HandledByClientID}
			if !once {
				// Discovery proves ownership, not runtime state or send readiness.
				// Publish before following: a bounded observer may reject the snapshot.
				publish(owner.id, protocol.DesktopObservation{Status: "unknown", Availability: "unavailable", Source: "codex-desktop", OwnerID: message.HandledByClientID})
			}
			if err := c.SetWriteDeadline(time.Now().Add(desktopRequestTimeout)); err != nil {
				return err
			}
			if err := c.follow(message.HandledByClientID, owner.id, true); err != nil {
				return err
			}
		}
	}
}

// The shared connection discovers ownership only. No state stream is followed,
// so an oversized target snapshot cannot poison another target's discovery.
func (o *DesktopObserver) discoverDesktopOwners(ctx context.Context, ids []string, publish func(desktopOwnerEvent)) (err error) {
	queue := o.discovery.targets(ids)
	c, cleanup, err := connectDesktop(ctx, o.socketPath)
	if err != nil {
		return err
	}
	if err := c.SetReadDeadline(time.Time{}); err != nil {
		cleanup()
		return err
	}
	events, readerDone := make(chan desktopReadResult), make(chan struct{})
	readCtx, cancel := context.WithCancel(ctx)
	go readDesktopEvents(readCtx, c, events, readerDone)
	defer func() {
		cancel()
		cleanup()
		<-readerDone
	}()
	pending := make(map[string]desktopPendingOwner)
	ticker := time.NewTicker(desktopDiscoveryTick)
	defer ticker.Stop()
	for len(queue) > 0 || len(pending) > 0 {
		if err := ctx.Err(); err != nil {
			return err
		}
		for requestID, target := range pending {
			if !time.Now().Before(target.deadline) {
				delete(pending, requestID)
				publish(desktopOwnerEvent{id: target.id})
			}
		}
		for len(queue) > 0 && len(pending) < desktopDiscoveryConcurrency {
			target := queue[0]
			queue = queue[1:]
			if err := c.SetWriteDeadline(time.Now().Add(desktopRequestTimeout)); err != nil {
				return err
			}
			requestID, err := c.sendRequest(desktopDiscoverOwner, 1, map[string]string{"hostId": "local", "conversationId": target.id})
			if err != nil {
				return err
			}
			o.discovery.dispatched(target)
			pending[requestID] = desktopPendingOwner{id: target.id, deadline: time.Now().Add(o.ownerTimeout)}
		}
		if len(queue) == 0 && len(pending) == 0 {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		case event := <-events:
			if event.err != nil {
				return fmt.Errorf("read desktop discovery: %w", event.err)
			}
			message := event.message
			if message.Type != "response" {
				continue
			}
			target, known := pending[message.RequestID]
			if !known {
				continue
			}
			delete(pending, message.RequestID)
			if !time.Now().Before(target.deadline) || message.ResultType == "error" {
				publish(desktopOwnerEvent{id: target.id})
				continue
			}
			if message.ResultType != "success" || message.Method != desktopDiscoverOwner {
				publish(desktopOwnerEvent{id: target.id})
				continue
			}
			if !protocol.ValidHistoryIdentity(message.HandledByClientID) || !protocol.ValidTurnID(message.HandledByClientID) || message.HandledByClientID == c.clientID {
				publish(desktopOwnerEvent{id: target.id})
				continue
			}
			publish(desktopOwnerEvent{id: target.id, owner: message.HandledByClientID})
		}
	}
	return nil
}
