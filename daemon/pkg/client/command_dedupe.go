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
	// The durable journal owns both replay protection and unacknowledged bodies.
	// Keeping a second receipt here would retain output after the journal ACK.
	if d.journal != nil {
		return dedupeEntry{}, false
	}
	d.dedupeMu.Lock()
	defer d.dedupeMu.Unlock()
	entry, ok := d.dedupeCache[commandID]
	return entry, ok
}

func (d *Daemon) recordDedupe(res protocol.DaemonResultMessage, fingerprint string) {
	if d.journal != nil {
		return
	}
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

func (d *Daemon) ackDedupe(ack protocol.ResultAckMessage) {
	d.dedupeMu.Lock()
	defer d.dedupeMu.Unlock()
	entry, exists := d.dedupeCache[ack.CommandID]
	if !exists || !protocol.ReceiptMatchesAck(entry.result, ack) {
		return
	}
	// Preserve the fingerprint and receipt identity so duplicate mutations stay
	// blocked. Absence of the acknowledged body must not imply an empty result.
	entry.result.Output = ""
	entry.result.OutputPresent = false
	entry.result.Error = ""
	d.dedupeCache[ack.CommandID] = entry
}
