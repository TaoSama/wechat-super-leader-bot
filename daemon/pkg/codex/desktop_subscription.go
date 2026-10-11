package codex

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	// Idle per-target connections do not consume the shared frame-processing budget.
	desktopSubscriptionConcurrency = 16
	desktopSubscriptionWindow      = 10 * time.Second
)

type desktopOwnerEvent struct {
	id, owner string
	done      bool
	err       error
}

type desktopSubscriptionEvent struct {
	id          string
	observation protocol.DesktopObservation
	started     bool
	done        bool
	err         error
}

type desktopActiveSubscription struct {
	target   desktopDiscoveryTarget
	cancel   context.CancelFunc
	rotateAt time.Time
	rotating bool
}

func (o *DesktopObserver) watchSubscriptions(parent context.Context, ids []string, publish func(string, protocol.DesktopObservation)) error {
	for _, id := range ids {
		if !protocol.ValidHistoryIdentity(id) {
			return errors.New("invalid desktop session ID")
		}
	}
	if len(ids) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(parent, o.watchWindow)
	var workers sync.WaitGroup
	owners := make(map[string]string)
	defer func() {
		cancel()
		workers.Wait()
		for id, owner := range owners {
			publish(id, protocol.DesktopObservation{Status: "unknown", Availability: "unavailable", Source: "codex-desktop", OwnerID: owner})
		}
	}()
	ownerEvents := make(chan desktopOwnerEvent, desktopDiscoveryConcurrency)
	events := make(chan desktopSubscriptionEvent, o.subscriptionLimit)
	workers.Add(1)
	go func() {
		defer workers.Done()
		send := func(event desktopOwnerEvent) {
			select {
			case ownerEvents <- event:
			case <-ctx.Done():
			}
		}
		err := o.discoverDesktopOwners(ctx, ids, send)
		send(desktopOwnerEvent{done: true, err: err})
	}()
	queue := o.subscriptions.targets(ids)
	started := make(map[string]bool)
	resolved := make(map[string]bool)
	active := make(map[string]*desktopActiveSubscription)
	rotationTimer := time.NewTimer(o.subscriptionWindow)
	defer rotationTimer.Stop()
	forward := func(id string, observation protocol.DesktopObservation) {
		o.discovery.observe(id, observation.Availability == "available")
		o.subscriptions.observe(id, observation.Availability == "available")
		publish(id, observation)
	}
	for {
		if ctx.Err() != nil {
			return parent.Err()
		}
		blockedKnown := false
		for _, target := range queue {
			if len(active) == o.subscriptionLimit {
				break
			}
			owner, ready := owners[target.id]
			// Do not let earlier responses jump the persistent known-owner cursor.
			// Unknown/silent catalog candidates do not gate this lane or each other.
			if target.known && !started[target.id] && !resolved[target.id] {
				blockedKnown = true
			}
			if target.known && blockedKnown {
				continue
			}
			if !ready || started[target.id] {
				continue
			}
			started[target.id] = true
			subCtx, subCancel := context.WithCancel(ctx)
			active[target.id] = &desktopActiveSubscription{target: target, cancel: subCancel}
			workers.Add(1)
			go func(subCtx context.Context, subCancel context.CancelFunc, id, owner string) {
				defer workers.Done()
				defer subCancel()
				err := o.subscribeDesktopTarget(subCtx, id, owner, func() {
					select {
					case events <- desktopSubscriptionEvent{id: id, started: true}:
					case <-ctx.Done():
					}
				}, func(observation protocol.DesktopObservation) {
					select {
					case events <- desktopSubscriptionEvent{id: id, observation: observation}:
					case <-ctx.Done():
					}
				})
				select {
				case events <- desktopSubscriptionEvent{id: id, done: true, err: err}:
				case <-ctx.Done():
				}
			}(subCtx, subCancel, target.id, owner)
		}
		// Rotate only at connection capacity with another proved owner waiting.
		// A discovery gate or cold catalog entry must not evict healthy owners
		// while there are still free connection slots.
		waiting := 0
		if len(active) == o.subscriptionLimit {
			for id := range owners {
				if !started[id] {
					waiting++
				}
			}
		}
		for _, subscription := range active {
			if waiting > 0 && !subscription.rotating && !subscription.rotateAt.IsZero() && !time.Now().Before(subscription.rotateAt) {
				subscription.rotating = true
				subscription.cancel()
				waiting--
			}
		}
		var rotation <-chan time.Time
		if !rotationTimer.Stop() {
			select {
			case <-rotationTimer.C:
			default:
			}
		}
		var nextRotation time.Time
		if waiting > 0 {
			for _, subscription := range active {
				if !subscription.rotating && !subscription.rotateAt.IsZero() && (nextRotation.IsZero() || subscription.rotateAt.Before(nextRotation)) {
					nextRotation = subscription.rotateAt
				}
			}
		}
		if !nextRotation.IsZero() {
			rotationTimer.Reset(time.Until(nextRotation))
			rotation = rotationTimer.C
		}
		select {
		case <-ctx.Done():
			return parent.Err()
		case <-rotation:
		case event := <-ownerEvents:
			if event.done {
				if event.err != nil && ctx.Err() == nil {
					return event.err
				}
				continue
			}
			resolved[event.id] = true
			if event.owner != "" {
				owners[event.id] = event.owner
			}
			publish(event.id, protocol.DesktopObservation{Status: "unknown", Availability: "unavailable", Source: "codex-desktop", OwnerID: event.owner})
		case event := <-events:
			subscription := active[event.id]
			if subscription == nil {
				return errors.New("unknown desktop subscription event")
			}
			if event.started {
				o.subscriptions.dispatched(subscription.target)
				continue
			}
			if !event.done {
				if subscription.rotating {
					continue
				}
				if subscription.rotateAt.IsZero() {
					subscription.rotateAt = time.Now().Add(o.subscriptionWindow)
				}
				forward(event.id, event.observation)
				continue
			}
			delete(active, event.id)
			subscription.cancel()
			forward(event.id, protocol.DesktopObservation{Status: "unknown", Availability: "unavailable", Source: "codex-desktop", OwnerID: owners[event.id]})
			if subscription.rotating && errors.Is(event.err, context.Canceled) {
				// A healthy, deliberately rotated target goes behind all waiting
				// owners. Actual failures remain attempted until the next window.
				delete(started, event.id)
				for index, target := range queue {
					if target.id == event.id {
						queue = append(append(queue[:index], queue[index+1:]...), target)
						break
					}
				}
				continue
			}
			if event.err != nil && ctx.Err() == nil {
				reason := "invalid-state-or-transport"
				if errors.Is(event.err, errDesktopFrameTooLarge) {
					reason = "frame-too-large"
				} else if errors.Is(event.err, context.DeadlineExceeded) || errors.Is(event.err, context.Canceled) {
					reason = "subscription-window-ended"
				}
				log.Printf("desktop target subscription unavailable: %s", reason)
			}
		}
	}
}

// A single target owns this reader. Rejecting a frame header never requires
// draining an oversized body or trusting its target identity to isolate failure.
func (o *DesktopObserver) subscribeDesktopTarget(ctx context.Context, id, owner string, followed func(), publish func(protocol.DesktopObservation)) (err error) {
	// Cancellation closes the transport asynchronously, including while scalar
	// delivery is blocked. Preserve its cause rather than exposing net.ErrClosed.
	defer func() {
		if ctx.Err() != nil {
			err = ctx.Err()
		}
	}()
	if err := o.frameBudget.acquire(ctx); err != nil {
		return err
	}
	c, cleanup, err := connectDesktop(ctx, o.socketPath)
	o.frameBudget.release()
	if err != nil {
		return err
	}
	defer cleanup()
	if owner == c.clientID {
		return errors.New("invalid desktop owner identity")
	}
	defer func() {
		if ctx.Err() == nil {
			if deadlineErr := c.SetWriteDeadline(time.Now().Add(desktopUnsubscribeTimeout)); deadlineErr != nil {
				err = errors.Join(err, deadlineErr)
			} else if followErr := c.follow(owner, id, false); followErr != nil {
				err = errors.Join(err, followErr)
			}
		}
	}()
	headerDeadline := time.Now().Add(o.ownerTimeout)
	if err := c.SetWriteDeadline(time.Now().Add(desktopRequestTimeout)); err != nil {
		return err
	}
	if err := c.follow(owner, id, true); err != nil {
		return err
	}
	followed()
	projection := &desktopProjection{owner: owner}
	projections := map[string]*desktopProjection{id: projection}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := c.SetReadDeadline(headerDeadline); err != nil {
			return err
		}
		var observation protocol.DesktopObservation
		observed := false
		err := c.readBudgeted(ctx, o.frameBudget, func(message desktopEnvelope) error {
			return applyDesktopChange(message, c.clientID, projections, func(_ string, scalar protocol.DesktopObservation) {
				observation, observed = scalar, true
			})
		})
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return err
		}
		if observed {
			publish(observation)
		}
		if projection.initialized {
			headerDeadline = time.Time{}
		}
	}
}
