// Package journal stores dispatch claims and result receipts on the native host.
// The Controller remains the authoritative orchestrator; this is a replay guard,
// never a queue that is allowed to restart unfinished work.
package journal

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
	"unicode/utf8"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/terminal"
	bolt "go.etcd.io/bbolt"
)

const (
	MaxPending       = 2048
	MaxRecords       = 1000000
	MaxDatabaseBytes = 512 * 1024 * 1024
	MaxEntryBytes    = protocol.MaxDaemonResultMessageBytes + 64*1024
	FileName         = "commands.db"
)

var (
	recordsBucket = []byte("records-v1")
	pendingBucket = []byte("pending-v1")
	metaBucket    = []byte("meta-v1")
	ErrConflict   = errors.New("command journal payload conflict")
	ErrCapacity   = errors.New("command journal capacity reached")
)

type Entry struct {
	Fingerprint      string                       `json:"fingerprint"`
	SessionID        string                       `json:"sessionId,omitempty"`
	Dispatch         *protocol.DispatchIdentity   `json:"dispatch,omitempty"`
	TerminalDelivery *terminal.DeliveryIdentity   `json:"terminalDelivery,omitempty"`
	Result           protocol.DaemonResultMessage `json:"result"`
	Finished         bool                         `json:"finished"`
	Acknowledged     bool                         `json:"acknowledged"`
}

type Journal struct{ db *bolt.DB }

func Open(directory, scope string) (*Journal, error) {
	if !filepath.IsAbs(directory) || scope == "" {
		return nil, errors.New("journal requires an absolute private directory and scope")
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	if err := checkPrivatePath(directory, true); err != nil {
		return nil, err
	}
	path := filepath.Join(directory, FileName)
	pathErr := checkPrivatePath(path, false)
	if pathErr != nil && !errors.Is(pathErr, os.ErrNotExist) {
		return nil, pathErr
	}
	existing := pathErr == nil
	if existing {
		info, err := os.Stat(path)
		if err != nil {
			return nil, err
		}
		if info.Size() == 0 {
			return nil, errors.New("existing command journal is empty; refusing to reset replay protection")
		}
	}
	db, err := bolt.Open(path, 0600, &bolt.Options{Timeout: time.Second, MaxSize: MaxDatabaseBytes})
	if err != nil {
		return nil, fmt.Errorf("open command journal: %w", err)
	}
	j := &Journal{db: db}
	if err := j.initialize(scope, !existing); err != nil {
		return nil, errors.Join(err, db.Close())
	}
	// Persist the directory entry as well as bbolt's synced data pages.
	dir, err := os.Open(directory)
	if err != nil {
		return nil, errors.Join(err, db.Close())
	}
	err = errors.Join(dir.Sync(), dir.Close())
	if err != nil {
		return nil, errors.Join(err, db.Close())
	}
	return j, nil
}

func checkPrivatePath(path string, directory bool) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || info.IsDir() != directory || (!directory && !info.Mode().IsRegular()) || info.Mode().Perm()&0077 != 0 {
		return errors.New("journal path must be private and must not be a symlink")
	}
	return nil
}

func (j *Journal) initialize(scope string, allowCreate bool) error {
	return j.db.Update(func(tx *bolt.Tx) error {
		if !allowCreate && (tx.Bucket(metaBucket) == nil || tx.Bucket(recordsBucket) == nil || tx.Bucket(pendingBucket) == nil) {
			return errors.New("existing command journal schema missing")
		}
		meta, err := tx.CreateBucketIfNotExists(metaBucket)
		if err != nil {
			return err
		}
		stored := meta.Get([]byte("scope"))
		if !allowCreate && stored == nil {
			return errors.New("existing command journal scope missing")
		}
		if stored != nil && string(stored) != scope {
			return errors.New("journal belongs to a different node/controller/socket scope")
		}
		if err := meta.Put([]byte("scope"), []byte(scope)); err != nil {
			return err
		}
		records, err := tx.CreateBucketIfNotExists(recordsBucket)
		if err != nil {
			return err
		}
		pending, err := tx.CreateBucketIfNotExists(pendingBucket)
		if err != nil {
			return err
		}
		var recoverEntries []Entry
		err = records.ForEach(func(key, value []byte) error {
			entry, err := decode(key, value)
			if err != nil {
				return err
			}
			if !entry.Finished {
				entry.Finished = true
				entry.Result = unknownResult(string(key))
				recoverEntries = append(recoverEntries, entry)
			}
			if !entry.Acknowledged && pending.Get(key) == nil {
				return errors.New("journal pending index is inconsistent")
			}
			return nil
		})
		if err != nil {
			return err
		}
		for _, entry := range recoverEntries {
			if err := put(records, entry); err != nil {
				return err
			}
		}
		return pending.ForEach(func(key, _ []byte) error {
			entry, err := decode(key, records.Get(key))
			if err != nil {
				return err
			}
			if entry.Acknowledged {
				return errors.New("journal acknowledgement index is inconsistent")
			}
			return nil
		})
	})
}

func fingerprint(cmd protocol.ControllerCommandMessage) string {
	sum := sha256.Sum256([]byte(cmd.PayloadFingerprint()))
	return hex.EncodeToString(sum[:])
}

func unknownResult(commandID string) protocol.DaemonResultMessage {
	return protocol.DaemonResultMessage{Type: "result", CommandID: commandID, Status: protocol.StatusUncertain,
		Error: "Daemon stopped after durable dispatch claim; execution is unconfirmed and will not be replayed"}
}

func decode(key, value []byte) (Entry, error) {
	var entry Entry
	if len(value) == 0 || len(value) > MaxEntryBytes || json.Unmarshal(value, &entry) != nil {
		return entry, errors.New("invalid command journal entry")
	}
	digest, err := hex.DecodeString(entry.Fingerprint)
	if err != nil || len(digest) != sha256.Size || entry.Result.Type != "result" || entry.Result.CommandID != string(key) ||
		(entry.Result.Status != protocol.StatusAccepted && entry.Result.Status != protocol.StatusCompleted && entry.Result.Status != protocol.StatusFailed && entry.Result.Status != protocol.StatusUncertain && entry.Result.Status != protocol.StatusInputWritten) ||
		(entry.Acknowledged && !entry.Finished) {
		return Entry{}, errors.New("invalid command journal entry")
	}
	if entry.Dispatch != nil {
		if err := validateDispatch(*entry.Dispatch, false); err != nil {
			return Entry{}, err
		}
	}
	if err := validateTerminalEntry(entry); err != nil {
		return Entry{}, err
	}
	if entry.Acknowledged {
		// Acknowledgement relinquishes the body to the Controller. An empty
		// stored placeholder is pruning, never evidence of a recorded empty result.
		entry.Result.Output = ""
		entry.Result.OutputPresent = false
		entry.Result.Error = ""
	}
	return entry, nil
}

func put(bucket *bolt.Bucket, entry Entry) error {
	if len(entry.Result.Output) > protocol.MaxTurnOutputBytes {
		return protocol.ErrTurnOutputLimit
	}
	if !utf8.ValidString(entry.Result.Output) {
		return errors.New("command journal output contains invalid UTF-8")
	}
	encoded, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	if len(encoded) > MaxEntryBytes {
		return errors.New("command journal result exceeds size limit")
	}
	if _, err := decode([]byte(entry.Result.CommandID), encoded); err != nil {
		return err
	}
	return bucket.Put([]byte(entry.Result.CommandID), encoded)
}

func (j *Journal) Lookup(cmd protocol.ControllerCommandMessage) (Entry, bool, error) {
	var entry Entry
	found := false
	err := j.db.View(func(tx *bolt.Tx) error {
		data := tx.Bucket(recordsBucket).Get([]byte(cmd.CommandID))
		if data == nil {
			return nil
		}
		var err error
		entry, err = decode([]byte(cmd.CommandID), data)
		if err != nil {
			return err
		}
		if entry.Fingerprint != fingerprint(cmd) {
			return ErrConflict
		}
		found = true
		return nil
	})
	return entry, found, err
}

// Begin commits a claim before any adapter call. A pre-existing claim is never
// permission to execute again, even when no result was durably recorded.
func (j *Journal) Begin(cmd protocol.ControllerCommandMessage) (Entry, bool, error) {
	entry := Entry{Fingerprint: fingerprint(cmd), SessionID: cmd.SessionID, Result: unknownResult(cmd.CommandID)}
	created := false
	err := j.db.Update(func(tx *bolt.Tx) error {
		records, pending := tx.Bucket(recordsBucket), tx.Bucket(pendingBucket)
		if data := records.Get([]byte(cmd.CommandID)); data != nil {
			existing, err := decode([]byte(cmd.CommandID), data)
			if err != nil {
				return err
			}
			if existing.Fingerprint != entry.Fingerprint {
				return ErrConflict
			}
			entry = existing
			return nil
		}
		if records.Stats().KeyN >= MaxRecords || pending.Stats().KeyN >= MaxPending {
			return ErrCapacity
		}
		if cmd.Action == protocol.ActionSend && (cmd.SendRoute == protocol.RouteDesktopOwner || cmd.SendRoute == protocol.RouteAppServerResume) {
			messageID, err := protocol.NewDispatchID()
			if err != nil {
				return err
			}
			requestID, err := protocol.NewDispatchID()
			if err != nil {
				return err
			}
			entry.Dispatch = &protocol.DispatchIdentity{Route: cmd.SendRoute, SessionID: cmd.SessionID,
				ClientUserMessageID: messageID, RequestID: requestID}
		}
		if cmd.Action == protocol.ActionSend && cmd.SendRoute == protocol.RouteTerminalPane {
			requestID, err := protocol.NewDispatchID()
			if err != nil {
				return err
			}
			entry.TerminalDelivery = &terminal.DeliveryIdentity{SessionID: cmd.SessionID, RequestID: requestID}
		}
		if err := put(records, entry); err != nil {
			return err
		}
		if err := pending.Put([]byte(cmd.CommandID), []byte{1}); err != nil {
			return err
		}
		created = true
		return nil
	})
	return entry, created && err == nil, err
}

func (j *Journal) Finish(result protocol.DaemonResultMessage) error {
	return j.db.Update(func(tx *bolt.Tx) error {
		records := tx.Bucket(recordsBucket)
		entry, err := decode([]byte(result.CommandID), records.Get([]byte(result.CommandID)))
		if err != nil {
			return err
		}
		if entry.Finished {
			if protocol.SameResult(entry.Result, result) {
				return nil
			}
			return errors.New("journal result was already finalized")
		}
		entry.Result = result
		entry.Finished = true
		return put(records, entry)
	})
}

func (j *Journal) Ack(ack protocol.ResultAckMessage) error {
	return j.db.Update(func(tx *bolt.Tx) error {
		records := tx.Bucket(recordsBucket)
		data := records.Get([]byte(ack.CommandID))
		if data == nil {
			return nil
		}
		entry, err := decode([]byte(ack.CommandID), data)
		if err != nil {
			return err
		}
		if !entry.Finished || entry.Acknowledged || !protocol.ReceiptMatchesAck(entry.Result, ack) {
			return nil
		}
		entry.Acknowledged = true
		// The Controller owns the full audit output. Retain the replay guard and
		// turn/status receipt indefinitely, not the acknowledged conversation text.
		entry.Result.Output = ""
		entry.Result.OutputPresent = false
		entry.Result.Error = ""
		if err := put(records, entry); err != nil {
			return err
		}
		return tx.Bucket(pendingBucket).Delete([]byte(ack.CommandID))
	})
}

func (j *Journal) Unacked() ([]protocol.DaemonResultMessage, error) {
	var results []protocol.DaemonResultMessage
	err := j.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(pendingBucket).ForEach(func(key, _ []byte) error {
			entry, err := decode(key, tx.Bucket(recordsBucket).Get(key))
			if err != nil {
				return err
			}
			if entry.Finished && !entry.Acknowledged {
				results = append(results, entry.Result)
			}
			return nil
		})
	})
	return results, err
}

func (j *Journal) Close() error { return j.db.Close() }
