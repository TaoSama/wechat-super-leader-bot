package client

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/journal"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const maxPersistedOutputBytes = 16 * 1024
const maxPersistedErrorBytes = 1024

type commandJournal interface {
	Lookup(protocol.ControllerCommandMessage) (journal.Entry, bool, error)
	Begin(protocol.ControllerCommandMessage) (journal.Entry, bool, error)
	BindDispatch(protocol.ControllerCommandMessage, protocol.DispatchIdentity) error
	ReadDispatch(string, string, string) (protocol.DispatchIdentity, error)
	Finish(protocol.DaemonResultMessage) error
	Ack(protocol.ResultAckMessage) error
	Unacked() ([]protocol.DaemonResultMessage, error)
	Close() error
}

// OpenDaemon is the production constructor. NewDaemon remains an explicitly
// in-memory constructor for embedded fixtures; main never uses it directly.
func OpenDaemon(cfg *config.Config, adapter codex.SessionAdapter) (*Daemon, error) {
	scope, err := json.Marshal([]string{cfg.NodeID, cfg.ControllerURL, cfg.SocketPath})
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(scope)
	store, err := journal.Open(cfg.StateDir, hex.EncodeToString(digest[:]))
	if err != nil {
		return nil, err
	}
	d := NewDaemon(cfg, adapter)
	d.journal = store
	return d, nil
}

func (d *Daemon) Close() error {
	d.resetHistory()
	if d.journal == nil {
		return nil
	}
	return d.journal.Close()
}

// ExecuteCommand claims durably before calling the existing dispatch path.
// Restart recovery never calls an adapter for any already claimed command.
func (d *Daemon) ExecuteCommand(ctx context.Context, cmd protocol.ControllerCommandMessage) protocol.DaemonResultMessage {
	if d.journal == nil {
		return d.executeVolatileCommand(ctx, cmd)
	}
	if cmd.CommandID == "" || len(cmd.CommandID) > 128 || cmd.CommandID != strings.TrimSpace(cmd.CommandID) || cmd.NodeID != d.cfg.NodeID {
		return protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID, Status: protocol.StatusFailed, Error: "Invalid command identity"}
	}
	entry, found, err := d.journal.Lookup(cmd)
	if err != nil {
		return journalFailure(cmd.CommandID)
	}
	if found {
		return entry.Result
	}
	if err := cmd.Validate(d.cfg.NodeID, time.Now().UTC()); err != nil {
		return protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID, Status: protocol.StatusFailed, Error: err.Error()}
	}
	entry, created, err := d.journal.Begin(cmd)
	if err != nil {
		return journalFailure(cmd.CommandID)
	}
	if !created {
		return entry.Result
	}
	res := d.executeVolatileCommand(ctx, cmd)
	res.Output = boundedReceiptText(res.Output, maxPersistedOutputBytes)
	res.Error = boundedReceiptText(res.Error, maxPersistedErrorBytes)
	d.persistenceMu.Lock()
	d.pendingPersistence[cmd.CommandID] = res
	err = d.journal.Finish(res)
	if err == nil {
		delete(d.pendingPersistence, cmd.CommandID)
	}
	d.persistenceMu.Unlock()
	if err != nil {
		log.Print("Command result persistence unavailable; retaining result for retry and blocking duplicate execution")
		return journalFailure(cmd.CommandID)
	}
	return res
}

func journalFailure(commandID string) protocol.DaemonResultMessage {
	return protocol.DaemonResultMessage{Type: "result", CommandID: commandID, Status: protocol.StatusUncertain,
		Error: "Command journal unavailable or conflicting; execution is unconfirmed, do not replay"}
}

func boundedReceiptText(text string, limit int) string {
	const suffix = "...(truncated)"
	if len(text) <= limit {
		return text
	}
	end := limit - len(suffix)
	for end > 0 && !utf8.RuneStart(text[end]) {
		end--
	}
	return text[:end] + suffix
}

func (d *Daemon) flushJournal(send func(any) error) error {
	d.persistenceMu.Lock()
	var retryErr error
	for id, result := range d.pendingPersistence {
		if err := d.journal.Finish(result); err != nil {
			retryErr = errors.New("pending result persistence failed")
			break
		}
		delete(d.pendingPersistence, id)
	}
	d.persistenceMu.Unlock()
	if retryErr != nil {
		return retryErr
	}
	results, err := d.journal.Unacked()
	if err != nil {
		return errors.New("journal replay read unavailable")
	}
	for _, result := range results {
		if err := send(result); err != nil {
			return err
		}
	}
	return nil
}
