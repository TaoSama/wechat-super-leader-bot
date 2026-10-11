package journal

import (
	"errors"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/terminal"
	bolt "go.etcd.io/bbolt"
)

var ErrTerminalIdentity = errors.New("command journal terminal identity invalid or unavailable")

func validateTerminalEntry(entry Entry) error {
	identity := entry.TerminalDelivery
	if identity != nil {
		if entry.Dispatch != nil || !protocol.ValidInputRequestID(identity.RequestID) ||
			!protocol.ValidTerminalSessionID(identity.SessionID) || entry.Result.TurnID != "" || entry.Result.Output != "" ||
			(entry.Result.Status != protocol.StatusInputWritten && entry.Result.Status != protocol.StatusFailed && entry.Result.Status != protocol.StatusUncertain) {
			return ErrTerminalIdentity
		}
		if identity.Endpoint == "" {
			if *identity != (terminal.DeliveryIdentity{SessionID: identity.SessionID, RequestID: identity.RequestID}) {
				return ErrTerminalIdentity
			}
		} else if terminal.ValidateDeliveryIdentity(*identity) != nil {
			return ErrTerminalIdentity
		}
	}
	if entry.Result.Status == protocol.StatusInputWritten {
		proof := entry.Result.InputReceipt
		if identity == nil || identity.Endpoint == "" || proof == nil || proof.Validate() != nil ||
			proof.SessionID != identity.SessionID || proof.RequestID != identity.RequestID || proof.PromptSHA256 != identity.PromptSHA256 ||
			proof.ResponseRevision < identity.Revision || entry.Result.Output != "" || entry.Result.Error != "" || !entry.Finished {
			return ErrTerminalIdentity
		}
	} else if entry.Result.InputReceipt != nil {
		return ErrTerminalIdentity
	}
	return nil
}

// BindTerminal persists the complete immutable target and actual text digest
// after zero-input preparation and before the single permitted input write.
func (j *Journal) BindTerminal(cmd protocol.ControllerCommandMessage, identity terminal.DeliveryIdentity) error {
	if cmd.Action != protocol.ActionSend || cmd.SendRoute != protocol.RouteTerminalPane || identity.SessionID != cmd.SessionID ||
		terminal.ValidateDeliveryIdentity(identity) != nil {
		return ErrTerminalIdentity
	}
	return j.db.Update(func(tx *bolt.Tx) error {
		records := tx.Bucket(recordsBucket)
		entry, err := decode([]byte(cmd.CommandID), records.Get([]byte(cmd.CommandID)))
		if err != nil {
			return err
		}
		if entry.Fingerprint != fingerprint(cmd) {
			return ErrConflict
		}
		claim := entry.TerminalDelivery
		if entry.Finished || claim == nil || claim.SessionID != identity.SessionID || claim.RequestID != identity.RequestID {
			return ErrTerminalIdentity
		}
		if claim.Endpoint != "" {
			if *claim == identity {
				return nil
			}
			return ErrTerminalIdentity
		}
		entry.TerminalDelivery = &identity
		return put(records, entry)
	})
}
