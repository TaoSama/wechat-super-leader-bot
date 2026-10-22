package client

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	catalogRecoveryConcurrency = 2
	catalogRecoveryTimeout     = 3 * time.Second
	catalogRecoveryRecheck     = 15 * time.Second
	catalogRecoveryTick        = 250 * time.Millisecond
)

func (d *Daemon) managedSessionLocked(id string) (protocol.Session, bool) {
	for _, session := range d.sessionSnapshot {
		if session.ID == id {
			return session, true
		}
	}
	verified, ok := d.managedCatalog[id]
	if !ok {
		return protocol.Session{}, false
	}
	for _, session := range d.catalogSnapshot {
		if session.ID == id {
			return verified, true
		}
	}
	return protocol.Session{}, false
}

// Caller holds snapshotMu. File metadata remains read-only until an exact live
// thread/read succeeds. Native discovery always takes precedence.
func (d *Daemon) managedSessionsLocked() []protocol.Session {
	sessions := cloneSessions(d.sessionSnapshot)
	present := make(map[string]bool, len(sessions))
	for _, session := range sessions {
		present[session.ID] = true
	}
	for _, stored := range d.catalogSnapshot {
		if verified, ok := d.managedCatalog[stored.ID]; ok && !present[stored.ID] {
			sessions = append(sessions, cloneSessions([]protocol.Session{verified})[0])
			present[stored.ID] = true
		}
	}
	return sessions
}

func (d *Daemon) catalogRecoveryTargets(now time.Time, next map[string]time.Time, running map[string]bool) []string {
	d.snapshotMu.Lock()
	defer d.snapshotMu.Unlock()
	known, native := map[string]bool{}, map[string]bool{}
	for _, session := range d.sessionSnapshot {
		native[session.ID] = true
	}
	ids := []string{}
	for _, session := range d.catalogSnapshot {
		if known[session.ID] || !protocol.ValidHistoryIdentity(session.ID) || isTerminalSession(session.ID) {
			continue
		}
		known[session.ID] = true
		if !native[session.ID] && !running[session.ID] && !now.Before(next[session.ID]) && !freshDesktopOwner(d.desktopSnapshot[session.ID], now) {
			ids = append(ids, session.ID)
		}
	}
	for id := range d.managedCatalog {
		if !known[id] || native[id] {
			delete(d.managedCatalog, id)
		}
	}
	for id := range next {
		if !known[id] {
			delete(next, id)
		}
	}
	sort.Slice(ids, func(i, j int) bool {
		if next[ids[i]].Equal(next[ids[j]]) {
			return ids[i] < ids[j]
		}
		return next[ids[i]].Before(next[ids[j]])
	})
	return ids
}

type catalogRecoveryResult struct {
	id      string
	session protocol.Session
	err     error
}

func (d *Daemon) completeCatalogRecovery(result catalogRecoveryResult, updates chan<- struct{}) {
	d.snapshotMu.Lock()
	delete(d.managedCatalog, result.id)
	known := false
	for _, stored := range d.catalogSnapshot {
		known = known || stored.ID == result.id
	}
	if known && result.err == nil && result.session.ID == result.id && result.session.Provider == codex.ProviderCodexApp &&
		!isTerminalSession(result.id) {
		d.managedCatalog[result.id] = cloneSessions([]protocol.Session{result.session})[0]
	}
	d.snapshotMu.Unlock()
	signalSnapshotUpdate(updates)
}

// Independent bounded reads recover list omissions without delaying discovery,
// heartbeats or command delivery. No read starts or resumes a thread.
func (d *Daemon) refreshCatalogRecovery(ctx context.Context, updates chan<- struct{}) {
	inspector, ok := d.adapter.(codex.SessionInspector)
	sender, resumeOK := d.adapter.(codex.ResumeSender)
	if !ok || !resumeOK || !d.durableJournal || d.journal == nil || d.cfg.SocketPath == "" || sender.Endpoint() != d.cfg.SocketPath || d.sessionCatalog == nil {
		return
	}
	ticker := time.NewTicker(catalogRecoveryTick)
	defer ticker.Stop()
	next, running := map[string]time.Time{}, map[string]bool{}
	results := make(chan catalogRecoveryResult, catalogRecoveryConcurrency)
	var workers sync.WaitGroup
	defer workers.Wait()
	for ctx.Err() == nil {
		for _, id := range d.catalogRecoveryTargets(time.Now(), next, running) {
			if len(running) >= catalogRecoveryConcurrency {
				break
			}
			running[id] = true
			workers.Add(1)
			go func(id string) {
				defer workers.Done()
				readCtx, cancel := context.WithTimeout(ctx, catalogRecoveryTimeout)
				session, err := inspector.InspectSession(readCtx, id)
				if err == nil {
					err = readCtx.Err()
				}
				cancel()
				results <- catalogRecoveryResult{id: id, session: session, err: err}
			}(id)
		}
		select {
		case <-ctx.Done():
			return
		case result := <-results:
			delete(running, result.id)
			next[result.id] = time.Now().Add(catalogRecoveryRecheck)
			if ctx.Err() == nil {
				d.completeCatalogRecovery(result, updates)
			}
		case <-ticker.C:
		}
	}
}
