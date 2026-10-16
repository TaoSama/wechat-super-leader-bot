package client

import (
	"context"
	"errors"
	"io"
	"net"
	"sort"
	"sync"
	"time"

	codexdesktop "github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/desktop"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	readinessConcurrency = 2
	readinessRecheck     = 30 * time.Second
	readinessTick        = 250 * time.Millisecond
	readinessTimeout     = 8 * time.Second
	// No probe has completed yet; a zero-length historical validity interval
	// does not misrepresent an observation event as a new readiness check.
	uncheckedReadinessTimestamp = "1970-01-01T00:00:00Z"
)

type desktopReadinessRecord struct {
	Availability protocol.SendAvailability
	Generation   uint64
	NextCheck    time.Time
}

type readinessJob struct {
	ID         string
	Generation uint64
}

type readinessResult struct {
	readinessJob
	Err error
}

func (d *Daemon) advanceDesktopGenerationLocked(id string) {
	d.desktopEpoch++
	d.desktopGeneration[id] = d.desktopEpoch
}

func sameDesktopProof(before, after protocol.DesktopObservation) bool {
	if before.Status != after.Status || before.Availability != after.Availability || before.Source != after.Source ||
		before.OwnerID != after.OwnerID || before.Revision != after.Revision {
		return false
	}
	// Production observations carry the exact owner/revision. Old fixtures and
	// other implementations without that proof invalidate on any timestamp change.
	return before.OwnerID != "" || before.ObservedAt == after.ObservedAt
}

func freshDesktopIdle(observation protocol.DesktopObservation, now time.Time) bool {
	observedAt, err := time.Parse(time.RFC3339Nano, observation.ObservedAt)
	return err == nil && observation.Source == "codex-desktop" && observation.Availability == "available" &&
		observation.Status == "idle" && !observedAt.After(now) && now.Sub(observedAt) <= protocol.MaxSendAvailabilityAge
}

func revokedReadiness(availability protocol.SendAvailability, observation protocol.DesktopObservation, now time.Time) protocol.SendAvailability {
	availability.State, availability.Reason = protocol.SendUnavailable, protocol.SendReasonUnavailable
	if freshDesktopIdle(observation, now) {
		availability.State, availability.Reason = protocol.SendBlocked, protocol.SendReasonChecking
	} else if observation.Availability == "available" && observation.Status == "active" {
		availability.State, availability.Reason = protocol.SendBlocked, protocol.SendReasonBusy
	}
	return availability
}

// Caller holds snapshotMu. Invalidation is not a new readiness check: preserve
// the prior observedAt/validUntil even when idle becomes busy or disconnected.
func (d *Daemon) invalidateSendReadinessLocked(id string, observation protocol.DesktopObservation, now time.Time) bool {
	if !d.cfg.DesktopSend {
		return false
	}
	record, exists := d.sendReadiness[id]
	// Discovery includes native-only sessions. Only the observer's exact owner
	// proof establishes desktop authority; retain any established denial forever
	// while the target remains known, even if later observations lose that proof.
	if !exists && observation.OwnerID == "" {
		return false
	}
	previous := record.Availability
	if !exists {
		record.Availability = protocol.SendAvailability{Route: protocol.RouteDesktopOwner,
			ObservedAt: uncheckedReadinessTimestamp, ValidUntil: uncheckedReadinessTimestamp}
	}
	record.Availability = revokedReadiness(record.Availability, observation, now)
	d.sendReadiness[id] = record
	return !exists || previous != record.Availability
}

func (d *Daemon) currentSendAvailabilityLocked(id string, record desktopReadinessRecord, now time.Time) protocol.SendAvailability {
	availability := record.Availability
	if !freshDesktopIdle(d.desktopSnapshot[id], now) {
		return revokedReadiness(availability, d.desktopSnapshot[id], now)
	}
	if availability.State != protocol.SendReady {
		return availability
	}
	until, err := time.Parse(time.RFC3339Nano, availability.ValidUntil)
	observedAt, observedErr := time.Parse(time.RFC3339Nano, availability.ObservedAt)
	if err != nil || observedErr != nil || observedAt.After(now) || !until.After(observedAt) || until.Sub(observedAt) > protocol.MaxSendAvailabilityAge ||
		!now.Before(until) || record.Generation != d.desktopGeneration[id] || !freshDesktopIdle(d.desktopSnapshot[id], now) {
		return revokedReadiness(availability, d.desktopSnapshot[id], now)
	}
	return availability
}

// A target is queued only after a fresh idle observer proof. No observer proof
// alone can grant ready, and the journal requirement matches actual dispatch.
func (d *Daemon) readinessSweep(now time.Time, running map[string]bool, capacity int, updates chan<- struct{}) []readinessJob {
	d.snapshotMu.Lock()
	known := map[string]bool{}
	for _, sessions := range [][]protocol.Session{d.sessionSnapshot, d.catalogSnapshot} {
		for _, session := range sessions {
			if !isTerminalSession(session.ID) {
				known[session.ID] = true
			}
		}
	}
	changed := false
	ids := make([]string, 0, len(d.sendReadiness))
	for id, record := range d.sendReadiness {
		if !known[id] {
			delete(d.sendReadiness, id)
			delete(d.desktopSnapshot, id)
			delete(d.desktopGeneration, id)
			continue
		}
		current := d.currentSendAvailabilityLocked(id, record, now)
		if current != record.Availability {
			record.Availability, changed = current, true
			d.sendReadiness[id] = record
		}
		if !running[id] && !now.Before(record.NextCheck) && freshDesktopIdle(d.desktopSnapshot[id], now) {
			ids = append(ids, id)
		}
	}
	sort.Slice(ids, func(i, j int) bool {
		left, right := d.sendReadiness[ids[i]].NextCheck, d.sendReadiness[ids[j]].NextCheck
		if left.Equal(right) {
			return ids[i] < ids[j]
		}
		return left.Before(right)
	})
	jobs := make([]readinessJob, 0, capacity)
	if d.desktopController != nil && d.journal != nil && d.cfg.DesktopSocketPath != "" {
		for _, id := range ids {
			if len(jobs) == capacity {
				break
			}
			record := d.sendReadiness[id]
			if record.Availability.State != protocol.SendReady {
				previous := record.Availability
				record.Availability.State, record.Availability.Reason = protocol.SendBlocked, protocol.SendReasonChecking
				d.sendReadiness[id] = record
				changed = changed || previous != record.Availability
			}
			jobs = append(jobs, readinessJob{ID: id, Generation: d.desktopGeneration[id]})
		}
	}
	d.snapshotMu.Unlock()
	if changed {
		signalSnapshotUpdate(updates)
	}
	return jobs
}

func (d *Daemon) completeReadiness(result readinessResult, now time.Time, updates chan<- struct{}) {
	d.snapshotMu.Lock()
	record, exists := d.sendReadiness[result.ID]
	if !exists {
		d.snapshotMu.Unlock()
		return
	}
	previous := record.Availability
	record.NextCheck = now.Add(readinessRecheck)
	observation := d.desktopSnapshot[result.ID]
	if result.Generation != d.desktopGeneration[result.ID] || !freshDesktopIdle(observation, now) {
		record.Availability = revokedReadiness(record.Availability, observation, now)
	} else {
		record.Generation = result.Generation
		record.Availability = protocol.SendAvailability{Route: protocol.RouteDesktopOwner, State: protocol.SendReady,
			ObservedAt: now.UTC().Format(time.RFC3339Nano), ValidUntil: now.Add(protocol.MaxSendAvailabilityAge).UTC().Format(time.RFC3339Nano)}
		if result.Err != nil {
			record.Availability.State, record.Availability.Reason = protocol.SendBlocked, protocol.SendReasonPreflightRejected
			var networkError net.Error
			if errors.Is(result.Err, codexdesktop.ErrDesktopSendBusy) {
				record.Availability.Reason = protocol.SendReasonBusy
			} else if errors.As(result.Err, &networkError) || errors.Is(result.Err, context.DeadlineExceeded) || errors.Is(result.Err, context.Canceled) ||
				errors.Is(result.Err, io.EOF) || errors.Is(result.Err, io.ErrUnexpectedEOF) || errors.Is(result.Err, net.ErrClosed) {
				record.Availability.State, record.Availability.Reason = protocol.SendUnavailable, protocol.SendReasonUnavailable
			}
		}
	}
	d.sendReadiness[result.ID] = record
	d.snapshotMu.Unlock()
	if previous != record.Availability {
		signalSnapshotUpdate(updates)
	}
}

// Independent, bounded probes keep slow owners out of discovery and heartbeats.
// Two buffered result slots let every worker terminate even during shutdown.
func (d *Daemon) refreshSendReadiness(ctx context.Context, updates chan<- struct{}) {
	if !d.cfg.DesktopSend || d.cfg.DesktopSocketPath == "" || d.desktopController == nil || d.journal == nil {
		return
	}
	ticker := time.NewTicker(readinessTick)
	defer ticker.Stop()
	results := make(chan readinessResult, readinessConcurrency)
	running := map[string]bool{}
	var workers sync.WaitGroup
	defer func() {
		workers.Wait()
		d.snapshotMu.Lock()
		for id, record := range d.sendReadiness {
			record.Availability.State, record.Availability.Reason = protocol.SendUnavailable, protocol.SendReasonUnavailable
			if running[id] {
				record.NextCheck = time.Now().Add(readinessRecheck)
			}
			d.sendReadiness[id] = record
		}
		d.snapshotMu.Unlock()
		signalSnapshotUpdate(updates)
	}()
	for ctx.Err() == nil {
		for _, job := range d.readinessSweep(time.Now(), running, readinessConcurrency-len(running), updates) {
			running[job.ID] = true
			workers.Add(1)
			go func(job readinessJob) {
				defer workers.Done()
				probeCtx, cancel := context.WithTimeout(ctx, readinessTimeout)
				err := d.desktopController.CheckSendReadiness(probeCtx, job.ID)
				if err == nil {
					err = probeCtx.Err()
				}
				cancel()
				results <- readinessResult{readinessJob: job, Err: err}
			}(job)
		}
		select {
		case <-ctx.Done():
			return
		case result := <-results:
			delete(running, result.ID)
			if ctx.Err() == nil {
				d.completeReadiness(result, time.Now(), updates)
			}
		case <-ticker.C:
		}
	}
}
