package client

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const terminalReadinessProbeText = "terminal readiness preflight"

type terminalReadinessRecord struct {
	Availability protocol.SendAvailability
	NextCheck    time.Time
}

func (d *Daemon) terminalSendingEnabled() bool {
	return d.cfg.TerminalSendMode == protocol.TerminalNonAtomicMode && d.terminalController != nil && d.durableJournal && d.journal != nil
}

func terminalObservationFresh(session protocol.Session, now time.Time) bool {
	observed, err := time.Parse(time.RFC3339Nano, session.ObservedAt)
	return err == nil && !observed.After(now) && now.Sub(observed) <= protocol.MaxSendAvailabilityAge && session.Status == "idle"
}

// Caller holds snapshotMu. Read-only observations never grant admission by
// themselves; only an independent zero-input Prepare/Close probe grants ready.
func (d *Daemon) terminalAvailabilityLocked(session protocol.Session, now time.Time) protocol.SendAvailability {
	record, found := d.terminalReadiness[session.ID]
	availability := record.Availability
	if !found {
		availability = protocol.SendAvailability{Route: protocol.RouteTerminalPane, Mode: protocol.TerminalNonAtomicMode,
			State: protocol.SendBlocked, Reason: protocol.SendReasonChecking,
			ObservedAt: uncheckedReadinessTimestamp, ValidUntil: uncheckedReadinessTimestamp}
	}
	if session.Status == "active" {
		availability.State, availability.Reason = protocol.SendBlocked, protocol.SendReasonBusy
	} else if !terminalObservationFresh(session, now) {
		availability.State, availability.Reason = protocol.SendUnavailable, protocol.SendReasonUnavailable
	} else if availability.State == protocol.SendReady {
		until, err := time.Parse(time.RFC3339Nano, availability.ValidUntil)
		observed, observedErr := time.Parse(time.RFC3339Nano, availability.ObservedAt)
		if err != nil || observedErr != nil || observed.After(now) || !until.After(observed) ||
			until.Sub(observed) > protocol.MaxSendAvailabilityAge || !now.Before(until) {
			availability.State, availability.Reason = protocol.SendUnavailable, protocol.SendReasonUnavailable
		}
	}
	return availability
}

func (d *Daemon) terminalReadinessJobs(now time.Time, running map[string]bool, capacity int) []string {
	d.snapshotMu.Lock()
	defer d.snapshotMu.Unlock()
	known := make(map[string]bool, len(d.terminalSnapshot))
	var jobs []string
	for _, session := range d.terminalSnapshot {
		known[session.ID] = true
		record := d.terminalReadiness[session.ID]
		record.Availability = d.terminalAvailabilityLocked(session, now)
		d.terminalReadiness[session.ID] = record
		if len(jobs) < capacity && !running[session.ID] && !now.Before(record.NextCheck) && terminalObservationFresh(session, now) {
			jobs = append(jobs, session.ID)
		}
	}
	for id := range d.terminalReadiness {
		if !known[id] {
			delete(d.terminalReadiness, id)
		}
	}
	return jobs
}

func (d *Daemon) checkTerminalReadiness(ctx context.Context, id string) error {
	requestID, err := protocol.NewDispatchID()
	if err != nil {
		return err
	}
	prepared, err := d.terminalController.PrepareDelivery(ctx, id, requestID, terminalReadinessProbeText)
	if err != nil {
		return err
	}
	// The probe never receives a journal claim and never invokes Dispatch.
	return errors.Join(ctx.Err(), prepared.Close())
}

func (d *Daemon) completeTerminalReadiness(id string, probeErr error, now time.Time, updates chan<- struct{}) {
	d.snapshotMu.Lock()
	record, exists := d.terminalReadiness[id]
	if !exists {
		d.snapshotMu.Unlock()
		return
	}
	record.NextCheck = now.Add(readinessRecheck)
	record.Availability = protocol.SendAvailability{Route: protocol.RouteTerminalPane, Mode: protocol.TerminalNonAtomicMode,
		State: protocol.SendReady, ObservedAt: now.UTC().Format(time.RFC3339Nano), ValidUntil: now.Add(protocol.MaxSendAvailabilityAge).UTC().Format(time.RFC3339Nano)}
	if probeErr != nil {
		record.Availability.State, record.Availability.Reason = protocol.SendBlocked, protocol.SendReasonPreflightRejected
	}
	d.terminalReadiness[id] = record
	d.snapshotMu.Unlock()
	signalSnapshotUpdate(updates)
}

func (d *Daemon) refreshTerminalReadiness(ctx context.Context, updates chan<- struct{}) {
	if !d.terminalSendingEnabled() {
		return
	}
	ticker := time.NewTicker(readinessTick)
	defer ticker.Stop()
	type probeResult struct {
		id  string
		err error
	}
	results := make(chan probeResult, readinessConcurrency)
	running := make(map[string]bool)
	var workers sync.WaitGroup
	defer func() { workers.Wait(); d.invalidateTerminal(updates) }()
	for ctx.Err() == nil {
		for _, id := range d.terminalReadinessJobs(time.Now(), running, readinessConcurrency-len(running)) {
			running[id] = true
			workers.Add(1)
			go func(id string) {
				defer workers.Done()
				probeCtx, cancel := context.WithTimeout(ctx, readinessTimeout)
				defer cancel()
				results <- probeResult{id, d.checkTerminalReadiness(probeCtx, id)}
			}(id)
		}
		select {
		case <-ctx.Done():
			return
		case result := <-results:
			delete(running, result.id)
			if ctx.Err() == nil {
				d.completeTerminalReadiness(result.id, result.err, time.Now(), updates)
			}
		case <-ticker.C:
		}
	}
}
