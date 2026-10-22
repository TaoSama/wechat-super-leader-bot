package client

import (
	"context"
	"fmt"
	"log"
	"reflect"
	"slices"
	"sort"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/skills"
)

const sessionRefreshInterval = 2 * time.Second
const sessionDiscoveryTimeout = 8 * time.Second
const regularHeartbeatInterval = 15 * time.Second

func cloneSessions(sessions []protocol.Session) []protocol.Session {
	copy := append([]protocol.Session{}, sessions...)
	for i := range copy {
		copy[i].Capabilities = append([]protocol.ActionType{}, sessions[i].Capabilities...)
		if sessions[i].Loaded != nil {
			loaded := *sessions[i].Loaded
			copy[i].Loaded = &loaded
		}
		if sessions[i].DesktopObservation != nil {
			observation := *sessions[i].DesktopObservation
			copy[i].DesktopObservation = &observation
		}
		if sessions[i].SendAvailability != nil {
			availability := *sessions[i].SendAvailability
			copy[i].SendAvailability = &availability
		}
	}
	return copy
}

func sessionsChanged(previous, current []protocol.Session) bool {
	normalize := func(sessions []protocol.Session) []protocol.Session {
		copy := cloneSessions(sessions)
		for i := range copy {
			copy[i].ObservedAt = ""
			if copy[i].DesktopObservation != nil {
				copy[i].DesktopObservation.ObservedAt = ""
				copy[i].DesktopObservation.OwnerID = ""
				copy[i].DesktopObservation.Revision = 0
			}
			sort.Slice(copy[i].Capabilities, func(a, b int) bool { return copy[i].Capabilities[a] < copy[i].Capabilities[b] })
		}
		sort.Slice(copy, func(a, b int) bool { return copy[a].ID < copy[b].ID })
		return copy
	}
	return !reflect.DeepEqual(normalize(previous), normalize(current))
}

func (d *Daemon) cachedSessions() []protocol.Session {
	d.snapshotMu.RLock()
	defer d.snapshotMu.RUnlock()
	sessions := mergeSessionSources(d.managedSessionsLocked(), d.catalogSnapshot)
	for i := range sessions {
		if !d.canResumeSendLocked(sessions[i].ID, time.Now()) {
			sessions[i].Capabilities = slices.DeleteFunc(sessions[i].Capabilities, func(capability protocol.ActionType) bool {
				return capability == protocol.CapabilityResumeSend
			})
		}
		sessions[i].SendAvailability = nil
		if observation, ok := d.desktopSnapshot[sessions[i].ID]; ok {
			sessions[i].DesktopObservation = &observation
		}
		if d.cfg.DesktopSend {
			if record, ok := d.sendReadiness[sessions[i].ID]; ok {
				availability := d.currentSendAvailabilityLocked(sessions[i].ID, record, time.Now())
				sessions[i].SendAvailability = &availability
			}
		}
	}
	terminals := cloneSessions(d.terminalSnapshot)
	if d.terminalSendingEnabled() {
		for i := range terminals {
			terminals[i].Capabilities = []protocol.ActionType{protocol.ActionRead, protocol.ActionSend}
			availability := d.terminalAvailabilityLocked(terminals[i], time.Now())
			terminals[i].SendAvailability = &availability
		}
	}
	return append(sessions, terminals...)
}

func (d *Daemon) refreshSessions(ctx context.Context, updates chan<- struct{}) {
	ticker := time.NewTicker(sessionRefreshInterval)
	defer ticker.Stop()
	for {
		d.refreshControlSnapshot(ctx, updates)
		if ctx.Err() != nil {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (d *Daemon) refreshControlSnapshot(ctx context.Context, updates chan<- struct{}) {
	readCtx, cancel := context.WithTimeout(ctx, sessionDiscoveryTimeout)
	sessions, err := d.adapter.DiscoverSessions(readCtx)
	readErr := readCtx.Err()
	cancel()
	if ctx.Err() != nil {
		return
	}
	if err != nil || readErr != nil {
		log.Printf("[daemon:%s] session discovery unavailable; retaining last observed snapshot", d.cfg.NodeID)
		return
	}
	d.snapshotMu.Lock()
	changed := sessionsChanged(d.sessionSnapshot, sessions)
	d.sessionSnapshot = cloneSessions(sessions)
	d.snapshotMu.Unlock()
	if changed {
		signalSnapshotUpdate(updates)
	}
}

func (d *Daemon) heartbeatLoop(ctx context.Context, updates <-chan struct{}, skillRefresh chan<- struct{}, catalog func() []skills.Skill, send func(any) error) error {
	interval := d.cfg.HeartbeatInterval
	if interval <= 0 || interval > regularHeartbeatInterval {
		interval = regularHeartbeatInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	lastSkillRefresh := time.Now()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-updates:
		case <-ticker.C:
			if time.Since(lastSkillRefresh) >= regularHeartbeatInterval {
				select {
				case skillRefresh <- struct{}{}:
				default:
				}
				lastSkillRefresh = time.Now()
			}
		}
		if ctx.Err() != nil {
			return nil
		}
		message := protocol.DaemonHeartbeatMessage{Type: "heartbeat", Sessions: d.cachedSessions(), Skills: catalog()}
		if err := send(message); err != nil {
			return fmt.Errorf("failed to send heartbeat: %w", err)
		}
		if err := d.flushResults(send); err != nil {
			return err
		}
	}
}
