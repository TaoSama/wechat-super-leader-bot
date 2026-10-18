package journal

import (
	"errors"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	bolt "go.etcd.io/bbolt"
)

var ErrTurnResultIdentity = errors.New("command journal turn result identity invalid or unavailable")

// RecordTurnResult advances the receipt for an existing accepted turn. It never
// creates a dispatch claim, changes the exact turn, or restarts execution.
func (j *Journal) RecordTurnResult(sessionID string, result protocol.DaemonResultMessage) error {
	if !protocol.ValidHistoryIdentity(sessionID) || !protocol.ValidTurnID(result.TurnID) || result.Type != "result" ||
		(result.Status != protocol.StatusCompleted && result.Status != protocol.StatusFailed) {
		return ErrTurnResultIdentity
	}
	return j.db.Update(func(tx *bolt.Tx) error {
		records, pending := tx.Bucket(recordsBucket), tx.Bucket(pendingBucket)
		entry, err := decode([]byte(result.CommandID), records.Get([]byte(result.CommandID)))
		if err != nil {
			return err
		}
		storedSessionID := entry.SessionID
		if storedSessionID == "" && entry.Dispatch != nil {
			storedSessionID = entry.Dispatch.SessionID
		}
		if !entry.Finished || storedSessionID != sessionID || entry.Result.TurnID != result.TurnID || entry.TerminalDelivery != nil {
			return ErrTurnResultIdentity
		}
		if entry.Result.Status != protocol.StatusAccepted {
			if protocol.SameResult(entry.Result, result) {
				return nil
			}
			return ErrTurnResultIdentity
		}
		if pending.Get([]byte(result.CommandID)) == nil && pending.Stats().KeyN >= MaxPending {
			return ErrCapacity
		}
		entry.Result = result
		entry.Acknowledged = false
		if err := put(records, entry); err != nil {
			return err
		}
		return pending.Put([]byte(result.CommandID), []byte{1})
	})
}
