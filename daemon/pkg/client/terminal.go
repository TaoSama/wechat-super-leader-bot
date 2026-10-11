package client

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"log"
	"strings"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const terminalRefreshInterval = 15 * time.Second
const terminalReadTimeout = 12 * time.Second
const terminalSessionPrefix = "terminal:"

func isTerminalSession(id string) bool { return strings.HasPrefix(id, terminalSessionPrefix) }

func validTerminalPublicID(id string) bool {
	if !isTerminalSession(id) {
		return false
	}
	encoded := strings.TrimPrefix(id, terminalSessionPrefix)
	digest, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	return err == nil && len(digest) == sha256.Size && base64.RawURLEncoding.EncodeToString(digest) == encoded
}

func nativeSessions(sessions []protocol.Session) []protocol.Session {
	result := make([]protocol.Session, 0, len(sessions))
	for _, session := range sessions {
		if !isTerminalSession(session.ID) {
			result = append(result, session)
		}
	}
	return result
}

func normalizeTerminalSessions(sessions []protocol.Session) ([]protocol.Session, error) {
	if len(sessions) > config.MaxTerminalPanes {
		return nil, errors.New("invalid terminal inventory")
	}
	result := cloneSessions(sessions)
	seen := make(map[string]bool, len(result))
	for i := range result {
		session := &result[i]
		if !validTerminalPublicID(session.ID) || !strings.HasPrefix(session.Provider, "terminal/") || session.Provider == "terminal/" || seen[session.ID] {
			return nil, errors.New("invalid terminal inventory")
		}
		seen[session.ID] = true
		loaded := false
		session.Loaded = &loaded
		session.Capabilities = []protocol.ActionType{protocol.ActionRead}
		session.DesktopObservation, session.SendAvailability = nil, nil
		session.Model, session.ModelProvider, session.ReasoningEffort, session.Preview = "", "", "", ""
		switch session.Status {
		case "active", "idle", "blocked", "unknown":
		default:
			session.Status = "unknown"
		}
	}
	return result, nil
}

func (d *Daemon) discoverTerminal(ctx context.Context) ([]protocol.Session, error) {
	if d.terminalObserver == nil {
		return nil, errors.New("terminal observation is disabled")
	}
	readCtx, cancel := context.WithTimeout(ctx, terminalReadTimeout)
	defer cancel()
	select {
	case d.terminalDiscovery <- struct{}{}:
		defer func() { <-d.terminalDiscovery }()
	case <-readCtx.Done():
		return nil, readCtx.Err()
	}
	sessions, err := d.terminalObserver.DiscoverSessions(readCtx)
	if readCtx.Err() != nil {
		return nil, readCtx.Err()
	}
	if err != nil {
		return nil, errors.New("terminal discovery unavailable")
	}
	return normalizeTerminalSessions(sessions)
}

func (d *Daemon) invalidateTerminal(updates chan<- struct{}) {
	d.snapshotMu.Lock()
	changed := false
	for i := range d.terminalSnapshot {
		if d.terminalSnapshot[i].Status != "unknown" {
			d.terminalSnapshot[i].Status = "unknown"
			changed = true
		}
		if record, exists := d.terminalReadiness[d.terminalSnapshot[i].ID]; exists {
			if record.Availability.State != protocol.SendUnavailable {
				changed = true
			}
			record.Availability.State, record.Availability.Reason = protocol.SendUnavailable, protocol.SendReasonUnavailable
			d.terminalReadiness[d.terminalSnapshot[i].ID] = record
		}
	}
	d.snapshotMu.Unlock()
	if changed {
		signalSnapshotUpdate(updates)
	}
}

func (d *Daemon) refreshTerminalSnapshot(ctx context.Context, updates chan<- struct{}) {
	if d.terminalObserver == nil {
		return
	}
	sessions, err := d.discoverTerminal(ctx)
	if ctx.Err() != nil {
		return
	}
	if err != nil {
		d.invalidateTerminal(updates)
		log.Printf("[daemon:%s] terminal observation unavailable; preserving original timestamps", d.cfg.NodeID)
		return
	}
	d.snapshotMu.Lock()
	changed := sessionsChanged(d.terminalSnapshot, sessions)
	d.terminalSnapshot = cloneSessions(sessions)
	d.snapshotMu.Unlock()
	if changed {
		signalSnapshotUpdate(updates)
	}
}

func (d *Daemon) refreshTerminal(ctx context.Context, updates chan<- struct{}) {
	if d.terminalObserver == nil {
		return
	}
	ticker := time.NewTicker(terminalRefreshInterval)
	defer ticker.Stop()
	defer d.invalidateTerminal(updates)
	d.refreshTerminalSnapshot(ctx, updates)
	for ctx.Err() == nil {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.refreshTerminalSnapshot(ctx, updates)
		}
	}
}

func (d *Daemon) readTerminal(ctx context.Context, id string) (string, error) {
	if d.terminalObserver == nil {
		return "", errors.New("terminal observation is disabled; no fallback was attempted")
	}
	readCtx, cancel := context.WithTimeout(ctx, terminalReadTimeout)
	defer cancel()
	output, err := d.terminalObserver.ReadSession(readCtx, id)
	if readCtx.Err() != nil {
		return "", readCtx.Err()
	}
	if err != nil {
		return "", errors.New("terminal snapshot unavailable; no fallback was attempted")
	}
	return output, nil
}
