package client

import (
	"context"
	"log"
	"reflect"
	"sort"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func (d *Daemon) desktopSessionIDs() []string {
	sessions := d.cachedSessions()
	ids := make([]string, 0, len(sessions))
	for _, session := range sessions {
		if !isTerminalSession(session.ID) {
			ids = append(ids, session.ID)
		}
	}
	sort.Strings(ids)
	return ids
}

func desktopChanged(before, after protocol.DesktopObservation) bool {
	before.ObservedAt, after.ObservedAt = "", ""
	before.OwnerID, after.OwnerID = "", ""
	before.Revision, after.Revision = 0, 0
	return before != after
}

func signalSnapshotUpdate(updates chan<- struct{}) {
	select {
	case updates <- struct{}{}:
	default:
	}
}

func (d *Daemon) publishDesktop(id string, observation protocol.DesktopObservation, updates chan<- struct{}) {
	if isTerminalSession(id) {
		return
	}
	d.snapshotMu.Lock()
	known := false
	for _, session := range d.sessionSnapshot {
		if session.ID == id {
			known = true
			break
		}
	}
	for _, session := range d.catalogSnapshot {
		if session.ID == id {
			known = true
			break
		}
	}
	if !known {
		d.snapshotMu.Unlock()
		return
	}
	previous, exists := d.desktopSnapshot[id]
	if observation.Availability != "available" && exists &&
		(!protocol.ValidTurnID(observation.OwnerID) || observation.OwnerID == previous.OwnerID) {
		// Ownerless failures and a rediscovered same owner preserve stale metadata.
		// A new confirmed owner replaces it with an unavailable, empty projection.
		observation = previous
		observation.Availability = "unavailable"
	}
	d.desktopSnapshot[id] = observation
	changed := !exists || desktopChanged(previous, observation)
	if !exists || !sameDesktopProof(previous, observation) {
		d.advanceDesktopGenerationLocked(id)
		changed = d.invalidateSendReadinessLocked(id, observation, time.Now()) || changed
	}
	d.snapshotMu.Unlock()
	if changed {
		signalSnapshotUpdate(updates)
	}
}

func (d *Daemon) invalidateDesktop(updates chan<- struct{}) {
	d.snapshotMu.Lock()
	present := map[string]bool{}
	for _, session := range d.sessionSnapshot {
		present[session.ID] = true
	}
	for _, session := range d.catalogSnapshot {
		present[session.ID] = true
	}
	changed := false
	for id, observation := range d.desktopSnapshot {
		if !present[id] {
			delete(d.desktopSnapshot, id)
			delete(d.sendReadiness, id)
			delete(d.desktopGeneration, id)
			continue
		}
		if observation.Availability == "available" {
			observation.Availability = "unavailable"
			d.desktopSnapshot[id], changed = observation, true
			d.advanceDesktopGenerationLocked(id)
			changed = d.invalidateSendReadinessLocked(id, observation, time.Now()) || changed
		}
	}
	d.snapshotMu.Unlock()
	if changed {
		signalSnapshotUpdate(updates)
	}
}

// Desktop streaming has its own worker; slow snapshots cannot stall control
// discovery, heartbeats, history, or command acknowledgements.
func (d *Daemon) refreshDesktop(ctx context.Context, updates chan<- struct{}) {
	if d.desktopObserver == nil {
		return
	}
	ticker := time.NewTicker(sessionRefreshInterval)
	defer ticker.Stop()
	defer d.invalidateDesktop(updates)
	for ctx.Err() == nil {
		ids := d.desktopSessionIDs()
		if len(ids) == 0 {
			d.invalidateDesktop(updates)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				continue
			}
		}
		watchCtx, cancel := context.WithCancel(ctx)
		for _, id := range ids {
			d.publishDesktop(id, protocol.DesktopObservation{Status: "unknown", Availability: "unavailable", Source: "codex-desktop"}, updates)
		}
		done := make(chan error, 1)
		go func() {
			done <- d.desktopObserver.Watch(watchCtx, ids, func(id string, observation protocol.DesktopObservation) {
				d.publishDesktop(id, observation, updates)
			})
		}()
		restart := false
		for !restart {
			select {
			case <-ctx.Done():
				cancel()
				<-done
				return
			case err := <-done:
				cancel()
				d.invalidateDesktop(updates)
				if err != nil {
					log.Printf("[daemon:%s] desktop observation disconnected; preserving last observed timestamps", d.cfg.NodeID)
					select {
					case <-ctx.Done():
						return
					case <-ticker.C:
					}
				}
				restart = true
			case <-ticker.C:
				if !reflect.DeepEqual(ids, d.desktopSessionIDs()) {
					cancel()
					<-done
					d.invalidateDesktop(updates)
					restart = true
				}
			}
		}
		cancel()
	}
}
