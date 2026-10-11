package journal

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	bolt "go.etcd.io/bbolt"
)

// ScopeDigest computes the canonical scope hex digest from nodeID, controllerURL, and socketPath.
func ScopeDigest(nodeID, controllerURL, socketPath string) (string, error) {
	nodeID = strings.TrimSpace(nodeID)
	if nodeID == "" {
		return "", errors.New("nodeID must not be empty")
	}
	if strings.ContainsAny(nodeID, "\x00\r\n") {
		return "", errors.New("nodeID must not contain control characters")
	}
	if controllerURL == "" {
		return "", errors.New("controllerURL must not be empty")
	}
	if !filepath.IsAbs(socketPath) || strings.ContainsAny(socketPath, "\x00\r\n") {
		return "", errors.New("socketPath must be an absolute path without control characters")
	}

	raw, err := json.Marshal([]string{nodeID, controllerURL, socketPath})
	if err != nil {
		return "", fmt.Errorf("marshal scope: %w", err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

// TerminalReceipt represents a Controller terminal command summary used to verify
// that a journal record whose initial dispatch receipt was "accepted" has reached
// a terminal status ("completed" or "failed") on the Controller.
type TerminalReceipt struct {
	CommandID string                      `json:"commandId"`
	NodeID    string                      `json:"nodeId"`
	TurnID    string                      `json:"turnId"`
	Status    protocol.DaemonResultStatus `json:"status"`
}

// LoadReceiptsFile parses a JSON file containing a strict JSON array of TerminalReceipt.
func LoadReceiptsFile(path string) ([]TerminalReceipt, error) {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return nil, errors.New("receipts path must not be empty")
	}
	data, err := os.ReadFile(trimmed)
	if err != nil {
		return nil, fmt.Errorf("read receipts file: %w", err)
	}
	return ParseReceiptsJSON(data)
}

// ParseReceiptsJSON parses raw JSON bytes strictly expecting a JSON array of TerminalReceipt,
// and ensures no trailing data exists after the array.
func ParseReceiptsJSON(data []byte) ([]TerminalReceipt, error) {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return nil, errors.New("receipts JSON is empty")
	}
	if trimmed[0] != '[' {
		return nil, errors.New("receipts JSON must be a top-level array")
	}
	var list []TerminalReceipt
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&list); err != nil {
		return nil, fmt.Errorf("parse receipts array: %w", err)
	}
	var trailing any
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, errors.New("receipts JSON contains trailing data after array")
	}
	for i, r := range list {
		if strings.TrimSpace(r.CommandID) == "" {
			return nil, fmt.Errorf("receipt at index %d has empty commandId", i)
		}
		if strings.TrimSpace(r.NodeID) == "" {
			return nil, fmt.Errorf("receipt %s has empty nodeId", r.CommandID)
		}
		if strings.TrimSpace(r.TurnID) == "" {
			return nil, fmt.Errorf("receipt %s has empty turnId", r.CommandID)
		}
		if r.Status != protocol.StatusCompleted && r.Status != protocol.StatusFailed {
			return nil, fmt.Errorf("receipt %s has non-terminal status %q (expected completed or failed)", r.CommandID, r.Status)
		}
	}
	return list, nil
}

// MigrationOptions holds parameters for checking or applying a scope migration.
type MigrationOptions struct {
	StateDir   string
	NodeID     string
	SocketPath string
	FromURL    string
	ToURL      string
	Receipts   []TerminalReceipt
	Apply      bool
}

// MigrationReport summarizes counts and scopes without leaking record contents.
type MigrationReport struct {
	Applied               bool   `json:"applied"`
	FromScope             string `json:"from_scope"`
	ToScope               string `json:"to_scope"`
	RecordsCount          int    `json:"records_count"`
	RecordsSHA256         string `json:"records_sha256"`
	PendingCount          int    `json:"pending_count"`
	CompletedCount        int    `json:"completed_count"`
	FailedCount           int    `json:"failed_count"`
	AcceptedVerifiedCount int    `json:"accepted_verified_count"`
}

// Migrate inspects an existing journal, checks all safety preconditions,
// and conditionally updates the scope in meta-v1 if Apply is true.
// It never creates a journal if it does not already exist, and never mutates records or pending buckets.
func Migrate(opts MigrationOptions) (report *MigrationReport, err error) {
	opts.NodeID = strings.TrimSpace(opts.NodeID)
	if opts.NodeID == "" {
		return nil, errors.New("node-id must not be empty")
	}
	if strings.ContainsAny(opts.NodeID, "\x00\r\n") {
		return nil, errors.New("node-id must not contain control characters")
	}

	if opts.SocketPath == "" || !filepath.IsAbs(opts.SocketPath) || strings.ContainsAny(opts.SocketPath, "\x00\r\n") {
		return nil, errors.New("socket path must be an absolute path without control characters")
	}

	if opts.StateDir == "" || !filepath.IsAbs(opts.StateDir) || strings.ContainsAny(opts.StateDir, "\x00\r\n") {
		return nil, errors.New("state-dir must be an absolute path without control characters")
	}

	if err := config.ValidateControllerURL(opts.FromURL); err != nil {
		return nil, fmt.Errorf("invalid from controller URL: %w", err)
	}
	if err := config.ValidateControllerURL(opts.ToURL); err != nil {
		return nil, fmt.Errorf("invalid to controller URL: %w", err)
	}
	if opts.FromURL == opts.ToURL {
		return nil, errors.New("from and to controller URLs must be different")
	}

	fromScope, err := ScopeDigest(opts.NodeID, opts.FromURL, opts.SocketPath)
	if err != nil {
		return nil, err
	}
	toScope, err := ScopeDigest(opts.NodeID, opts.ToURL, opts.SocketPath)
	if err != nil {
		return nil, err
	}

	receiptMap := make(map[string]TerminalReceipt, len(opts.Receipts))
	for _, r := range opts.Receipts {
		if _, exists := receiptMap[r.CommandID]; exists {
			return nil, fmt.Errorf("duplicate receipt for commandId %s", r.CommandID)
		}
		receiptMap[r.CommandID] = r
	}

	// 1. Directory permissions
	if err := checkPrivatePath(opts.StateDir, true); err != nil {
		return nil, fmt.Errorf("state directory check failed: %w", err)
	}

	// 2. DB file permissions & non-creation check
	dbPath := filepath.Join(opts.StateDir, FileName)
	pathErr := checkPrivatePath(dbPath, false)
	if pathErr != nil {
		if errors.Is(pathErr, os.ErrNotExist) {
			return nil, errors.New("command journal does not exist; refusing to create")
		}
		return nil, fmt.Errorf("command journal check failed: %w", pathErr)
	}

	info, err := os.Stat(dbPath)
	if err != nil {
		return nil, err
	}
	if info.Size() == 0 {
		return nil, errors.New("command journal is empty")
	}

	// 3. Open DB with exclusive lock and without O_CREATE to eliminate creation race
	boltOpts := &bolt.Options{
		Timeout:  time.Second,
		MaxSize:  MaxDatabaseBytes,
		ReadOnly: !opts.Apply,
		OpenFile: func(name string, flag int, perm os.FileMode) (*os.File, error) {
			flag &^= os.O_CREATE
			return os.OpenFile(name, flag, perm)
		},
	}
	db, err := bolt.Open(dbPath, 0600, boltOpts)
	if err != nil {
		return nil, fmt.Errorf("open command journal: %w", err)
	}
	defer func() {
		if closeErr := db.Close(); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("close command journal: %w", closeErr))
		}
	}()

	rep := &MigrationReport{
		Applied:   false,
		FromScope: fromScope,
		ToScope:   toScope,
	}

	runChecks := func(tx *bolt.Tx) error {
		meta := tx.Bucket(metaBucket)
		records := tx.Bucket(recordsBucket)
		pending := tx.Bucket(pendingBucket)
		if meta == nil || records == nil || pending == nil {
			return errors.New("command journal schema missing")
		}

		storedScope := meta.Get([]byte("scope"))
		if storedScope == nil {
			return errors.New("existing command journal scope missing")
		}
		if string(storedScope) != fromScope {
			return errors.New("existing command journal scope mismatch")
		}

		// Ensure pending bucket is completely empty
		if pending.Stats().KeyN > 0 {
			return fmt.Errorf("journal has %d unacknowledged pending items; migration requires zero pending", pending.Stats().KeyN)
		}
		pendingEntries := 0
		if err := pending.ForEach(func(k, v []byte) error {
			pendingEntries++
			return nil
		}); err != nil {
			return err
		}
		if pendingEntries > 0 {
			return fmt.Errorf("journal has %d pending entries; migration requires zero pending", pendingEntries)
		}
		rep.PendingCount = 0

		// Check every record and accumulate records SHA256 in key order
		recordsCount := 0
		completedCount := 0
		failedCount := 0
		acceptedVerifiedCount := 0

		hasher := sha256.New()
		var lenBuf [4]byte

		err := records.ForEach(func(key, value []byte) error {
			recordsCount++
			binary.BigEndian.PutUint32(lenBuf[:], uint32(len(key)))
			hasher.Write(lenBuf[:])
			hasher.Write(key)
			binary.BigEndian.PutUint32(lenBuf[:], uint32(len(value)))
			hasher.Write(lenBuf[:])
			hasher.Write(value)

			cmdID := string(key)
			entry, err := decode(key, value)
			if err != nil {
				return fmt.Errorf("corrupt record %s: %w", cmdID, err)
			}
			if !entry.Finished {
				return fmt.Errorf("record %s is unfinished", cmdID)
			}
			if !entry.Acknowledged {
				return fmt.Errorf("record %s is not acknowledged", cmdID)
			}
			switch entry.Result.Status {
			case protocol.StatusCompleted:
				completedCount++
			case protocol.StatusFailed:
				failedCount++
			case protocol.StatusAccepted:
				if strings.TrimSpace(entry.Result.TurnID) == "" {
					return fmt.Errorf("record %s has accepted status without turnId", cmdID)
				}
				rec, ok := receiptMap[cmdID]
				if !ok {
					return fmt.Errorf("record %s has accepted status; terminal controller receipt required via -receipts", cmdID)
				}
				if rec.NodeID != opts.NodeID {
					return fmt.Errorf("record %s receipt nodeId mismatch", cmdID)
				}
				if rec.TurnID != entry.Result.TurnID {
					return fmt.Errorf("record %s receipt turnId mismatch", cmdID)
				}
				switch rec.Status {
				case protocol.StatusCompleted:
					completedCount++
					acceptedVerifiedCount++
				case protocol.StatusFailed:
					failedCount++
					acceptedVerifiedCount++
				default:
					return fmt.Errorf("record %s receipt has non-terminal status %q", cmdID, rec.Status)
				}
			case protocol.StatusUncertain:
				return fmt.Errorf("record %s has uncertain status; cannot migrate uncertain commands", cmdID)
			default:
				return fmt.Errorf("record %s has unexpected status %q", cmdID, entry.Result.Status)
			}
			return nil
		})
		if err != nil {
			return err
		}

		rep.RecordsCount = recordsCount
		rep.RecordsSHA256 = hex.EncodeToString(hasher.Sum(nil))
		rep.CompletedCount = completedCount
		rep.FailedCount = failedCount
		rep.AcceptedVerifiedCount = acceptedVerifiedCount
		return nil
	}

	if !opts.Apply {
		// Read-only inspection
		if err := db.View(runChecks); err != nil {
			return nil, err
		}
		return rep, nil
	}

	// Update scope inside write transaction
	err = db.Update(func(tx *bolt.Tx) error {
		if err := runChecks(tx); err != nil {
			return err
		}
		meta := tx.Bucket(metaBucket)
		if err := meta.Put([]byte("scope"), []byte(toScope)); err != nil {
			return fmt.Errorf("update scope: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	rep.Applied = true
	return rep, nil
}
