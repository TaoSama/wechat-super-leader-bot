package client

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const catalogRefreshInterval = 15 * time.Second
const catalogReadTimeout = 8 * time.Second

type sessionCatalog interface {
	DiscoverSessions(context.Context) ([]protocol.Session, error)
	ReadSession(context.Context, string) (string, error)
}

// Persistent files supply identities, never live execution or send authority.
// In particular, a fresh file scan cannot refresh an old control observation.
func mergeSessionSources(control, catalog []protocol.Session) []protocol.Session {
	result := cloneSessions(nativeSessions(control))
	positions := make(map[string]int, len(control))
	for i := range result {
		positions[result[i].ID] = i
	}
	for _, stored := range catalog {
		if !protocol.ValidHistoryIdentity(stored.ID) || isTerminalSession(stored.ID) {
			continue
		}
		if index, exists := positions[stored.ID]; exists {
			live := &result[index]
			if live.Title == "" {
				live.Title = stored.Title
			}
			if live.Cwd == "" {
				live.Cwd = stored.Cwd
			}
			continue
		}
		loaded := false
		stored.Loaded, stored.Status = &loaded, "unknown"
		stored.Capabilities = []protocol.ActionType{protocol.ActionRead}
		stored.DesktopObservation = nil
		stored.SendAvailability = nil
		positions[stored.ID] = len(result)
		result = append(result, stored)
	}
	return result
}

// Catalog discovery has its own single-flight worker, separate from native RPC,
// desktop subscriptions, heartbeats and command handling.
func (d *Daemon) refreshSessionCatalog(ctx context.Context, updates chan<- struct{}) {
	if d.sessionCatalog == nil {
		return
	}
	ticker := time.NewTicker(catalogRefreshInterval)
	defer ticker.Stop()
	for ctx.Err() == nil {
		d.refreshCatalogSnapshot(ctx, updates)
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

func (d *Daemon) refreshCatalogSnapshot(ctx context.Context, updates chan<- struct{}) {
	if d.sessionCatalog == nil {
		return
	}
	readCtx, cancel := context.WithTimeout(ctx, catalogReadTimeout)
	sessions, err := d.sessionCatalog.DiscoverSessions(readCtx)
	readErr := readCtx.Err()
	cancel()
	if ctx.Err() != nil {
		return
	}
	if err != nil || readErr != nil {
		log.Printf("[daemon:%s] session files unavailable; preserving original catalog observations", d.cfg.NodeID)
		return
	}
	d.snapshotMu.Lock()
	changed := sessionsChanged(d.catalogSnapshot, sessions)
	d.catalogSnapshot = cloneSessions(sessions)
	d.snapshotMu.Unlock()
	if changed {
		signalSnapshotUpdate(updates)
	}
}

func (d *Daemon) readSession(ctx context.Context, sessionID string) (string, error) {
	if isTerminalSession(sessionID) {
		return d.readTerminal(ctx, sessionID)
	}
	if d.sessionCatalog == nil {
		return d.adapter.ReadSession(ctx, sessionID)
	}
	d.snapshotMu.RLock()
	_, knownToControl := d.managedSessionLocked(sessionID)
	d.snapshotMu.RUnlock()
	if knownToControl {
		readCtx, cancel := context.WithTimeout(ctx, sessionDiscoveryTimeout)
		output, err := d.adapter.ReadSession(readCtx, sessionID)
		cancel()
		if err == nil {
			return output, nil
		}
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		log.Printf("[daemon:%s] live read unavailable; returning labeled file metadata if present", d.cfg.NodeID)
	}
	readCtx, cancel := context.WithTimeout(ctx, catalogReadTimeout)
	defer cancel()
	output, err := d.sessionCatalog.ReadSession(readCtx, sessionID)
	if readCtx.Err() != nil {
		return "", readCtx.Err()
	}
	if err != nil {
		return "", errors.New("session file metadata unavailable; history was not read")
	}
	return output, nil
}
