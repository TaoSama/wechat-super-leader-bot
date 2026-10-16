package client

import (
	"sync"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func (d *Daemon) getSessionLock(sessionID string) *sync.Mutex {
	d.sessionLocksMu.Lock()
	defer d.sessionLocksMu.Unlock()
	mu, exists := d.sessionLocks[sessionID]
	if !exists {
		mu = &sync.Mutex{}
		d.sessionLocks[sessionID] = mu
	}
	return mu
}

func (d *Daemon) checkDedupe(commandID string) (dedupeEntry, bool) {
	d.dedupeMu.Lock()
	defer d.dedupeMu.Unlock()
	entry, ok := d.dedupeCache[commandID]
	return entry, ok
}

func (d *Daemon) recordDedupe(res protocol.DaemonResultMessage, fingerprint string) {
	d.dedupeMu.Lock()
	defer d.dedupeMu.Unlock()
	if _, exists := d.dedupeCache[res.CommandID]; !exists {
		if len(d.dedupeOrder) >= MaxDedupeEntries {
			oldest := d.dedupeOrder[0]
			d.dedupeOrder = d.dedupeOrder[1:]
			delete(d.dedupeCache, oldest)
		}
		d.dedupeOrder = append(d.dedupeOrder, res.CommandID)
	}
	d.dedupeCache[res.CommandID] = dedupeEntry{
		result:      res,
		fingerprint: fingerprint,
	}
}
