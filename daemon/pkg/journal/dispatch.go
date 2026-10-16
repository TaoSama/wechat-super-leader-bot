package journal

import (
	"errors"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	bolt "go.etcd.io/bbolt"
)

var (
	ErrDispatchIdentity = errors.New("command journal dispatch identity invalid or unavailable")
	ErrNoDispatch       = errors.New("command journal has no bound runtime dispatch identity")
)

func validDispatchUUID(value string) bool {
	const uuidLength = 36
	if len(value) != uuidLength {
		return false
	}
	for index, char := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if char != '-' {
				return false
			}
		} else if !(char >= '0' && char <= '9' || char >= 'a' && char <= 'f') {
			return false
		}
	}
	return true
}

func validDispatchText(value string) bool {
	return protocol.ValidHistoryIdentity(value) && utf8.ValidString(value) &&
		!strings.ContainsFunc(value, func(char rune) bool {
			return unicode.IsControl(char) || unicode.IsSpace(char) || char == utf8.RuneError
		})
}

func validDispatchEndpoint(endpoint string) bool {
	const maxEndpointBytes = 4096
	return len(endpoint) <= maxEndpointBytes && strings.HasPrefix(endpoint, "/") &&
		filepath.IsAbs(endpoint) && filepath.Clean(endpoint) == endpoint && endpoint != "/" &&
		utf8.ValidString(endpoint) && !strings.ContainsFunc(endpoint, func(char rune) bool {
		return unicode.IsControl(char) || char == utf8.RuneError
	})
}

// A claim carries only preallocated UUIDs. Every bound identity has the exact
// endpoint selected before mutation; only desktop identities have an owner.
func validateDispatch(identity protocol.DispatchIdentity, requireBound bool) error {
	if (identity.Route != protocol.RouteDesktopOwner && identity.Route != protocol.RouteAppServerResume) || !validDispatchText(identity.SessionID) ||
		!validDispatchUUID(identity.ClientUserMessageID) || !validDispatchUUID(identity.RequestID) {
		return ErrDispatchIdentity
	}
	if !requireBound && identity.OwnerID == "" && identity.ConnectionID == "" && identity.Endpoint == "" {
		return nil
	}
	if identity.Route == protocol.RouteAppServerResume {
		if identity.OwnerID != "" || identity.ConnectionID != "" || !validDispatchEndpoint(identity.Endpoint) {
			return ErrDispatchIdentity
		}
		return nil
	}
	if !validDispatchText(identity.OwnerID) || !validDispatchText(identity.ConnectionID) || !validDispatchEndpoint(identity.Endpoint) {
		return ErrDispatchIdentity
	}
	return nil
}

// BindDispatch commits the immutable route before the native mutation write.
// A completed or restart-recovered claim can never be rebound for execution.
func (j *Journal) BindDispatch(cmd protocol.ControllerCommandMessage, identity protocol.DispatchIdentity) error {
	if cmd.Action != protocol.ActionSend || (cmd.SendRoute != protocol.RouteDesktopOwner && cmd.SendRoute != protocol.RouteAppServerResume) ||
		identity.Route != cmd.SendRoute || identity.SessionID != cmd.SessionID {
		return ErrDispatchIdentity
	}
	if err := validateDispatch(identity, true); err != nil {
		return err
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
		if entry.Finished || entry.Dispatch == nil {
			return ErrDispatchIdentity
		}
		claim := entry.Dispatch
		if claim.Route != identity.Route || claim.SessionID != identity.SessionID ||
			claim.ClientUserMessageID != identity.ClientUserMessageID || claim.RequestID != identity.RequestID {
			return ErrDispatchIdentity
		}
		if claim.OwnerID != "" || claim.ConnectionID != "" || claim.Endpoint != "" {
			if *claim == identity {
				return nil
			}
			return ErrDispatchIdentity
		}
		entry.Dispatch = &identity
		return put(records, entry)
	})
}

// ReadDispatch is read-only routing for a durably recorded exact turn;
// it never grants permission to dispatch or substitutes a newer turn identity.
func (j *Journal) ReadDispatch(commandID, sessionID, turnID string) (protocol.DispatchIdentity, error) {
	var identity protocol.DispatchIdentity
	if !validDispatchText(commandID) || !validDispatchText(sessionID) || !protocol.ValidTurnID(turnID) {
		return identity, ErrDispatchIdentity
	}
	err := j.db.View(func(tx *bolt.Tx) error {
		data := tx.Bucket(recordsBucket).Get([]byte(commandID))
		if data == nil {
			return ErrNoDispatch
		}
		entry, err := decode([]byte(commandID), data)
		if err != nil {
			return err
		}
		if entry.Dispatch == nil {
			return ErrNoDispatch
		}
		if !entry.Finished || entry.Dispatch.SessionID != sessionID || entry.Result.TurnID != turnID {
			return ErrDispatchIdentity
		}
		if err := validateDispatch(*entry.Dispatch, true); err != nil {
			return err
		}
		identity = *entry.Dispatch
		return nil
	})
	return identity, err
}
