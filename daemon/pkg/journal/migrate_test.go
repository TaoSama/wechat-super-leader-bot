package journal

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	bolt "go.etcd.io/bbolt"
)

func createTestJournalWithRecords(t *testing.T, dir, scope string, records []Entry) {
	t.Helper()
	j, err := Open(dir, scope)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}

	for _, rec := range records {
		cmd := testCommand(rec.Result.CommandID, "prompt for "+rec.Result.CommandID)
		if _, _, err := j.Begin(cmd); err != nil {
			t.Fatalf("Begin %s failed: %v", rec.Result.CommandID, err)
		}
		if rec.Finished {
			if err := j.Finish(rec.Result); err != nil {
				t.Fatalf("Finish %s failed: %v", rec.Result.CommandID, err)
			}
			if rec.Acknowledged {
				ack := protocol.ResultAckMessage{
					Type:      "ack",
					CommandID: rec.Result.CommandID,
					TurnID:    rec.Result.TurnID,
					Status:    rec.Result.Status,
				}
				if err := j.Ack(ack); err != nil {
					t.Fatalf("Ack %s failed: %v", rec.Result.CommandID, err)
				}
			}
		}
	}

	if err := j.Close(); err != nil {
		t.Fatalf("Close failed: %v", err)
	}
}

func readBucketDump(t *testing.T, dir string) (scope string, records map[string][]byte, pendingCount int) {
	t.Helper()
	dbPath := filepath.Join(dir, FileName)
	db, err := bolt.Open(dbPath, 0600, nil)
	if err != nil {
		t.Fatalf("open db for dump failed: %v", err)
	}
	defer func() {
		if closeErr := db.Close(); closeErr != nil {
			t.Errorf("dump db close failed: %v", closeErr)
		}
	}()

	records = make(map[string][]byte)
	err = db.View(func(tx *bolt.Tx) error {
		meta := tx.Bucket(metaBucket)
		if meta != nil {
			scope = string(meta.Get([]byte("scope")))
		}
		recBucket := tx.Bucket(recordsBucket)
		if recBucket != nil {
			if forEachErr := recBucket.ForEach(func(k, v []byte) error {
				valCopy := make([]byte, len(v))
				copy(valCopy, v)
				records[string(k)] = valCopy
				return nil
			}); forEachErr != nil {
				return forEachErr
			}
		}
		pendBucket := tx.Bucket(pendingBucket)
		if pendBucket != nil {
			pendingCount = pendBucket.Stats().KeyN
		}
		return nil
	})
	if err != nil {
		t.Fatalf("dump db failed: %v", err)
	}
	return scope, records, pendingCount
}

func TestMigrate_SuccessRetainsRecordsByteIdentical(t *testing.T) {
	dir := testPrivateDir(t)
	nodeID := "macair"
	fromURL := "ws://127.0.0.1:8790/v1/daemon"
	toURL := "wss://leader.taoai.site/v1/daemon"
	sockPath := "/tmp/test.sock"

	fromScope, err := ScopeDigest(nodeID, fromURL, sockPath)
	if err != nil {
		t.Fatal(err)
	}
	toScope, err := ScopeDigest(nodeID, toURL, sockPath)
	if err != nil {
		t.Fatal(err)
	}

	entries := []Entry{
		{
			Finished:     true,
			Acknowledged: true,
			Result: protocol.DaemonResultMessage{
				Type:      "result",
				CommandID: "cmd-1",
				Status:    protocol.StatusCompleted,
				TurnID:    "t-1",
			},
		},
		{
			Finished:     true,
			Acknowledged: true,
			Result: protocol.DaemonResultMessage{
				Type:      "result",
				CommandID: "cmd-2",
				Status:    protocol.StatusFailed,
				TurnID:    "t-2",
				Error:     "command failed gracefully",
			},
		},
		{
			Finished:     true,
			Acknowledged: true,
			Result: protocol.DaemonResultMessage{
				Type:      "result",
				CommandID: "cmd-3",
				Status:    protocol.StatusAccepted,
				TurnID:    "t-3",
			},
		},
	}
	createTestJournalWithRecords(t, dir, fromScope, entries)

	_, recordsBefore, _ := readBucketDump(t, dir)

	receipts := []TerminalReceipt{
		{
			CommandID: "cmd-3",
			NodeID:    nodeID,
			TurnID:    "t-3",
			Status:    protocol.StatusCompleted,
		},
	}

	// 1. Dry run check: does not modify scope
	opts := MigrationOptions{
		StateDir:   dir,
		NodeID:     nodeID,
		SocketPath: sockPath,
		FromURL:    fromURL,
		ToURL:      toURL,
		Receipts:   receipts,
		Apply:      false,
	}
	report, err := Migrate(opts)
	if err != nil {
		t.Fatalf("dry run Migrate failed: %v", err)
	}
	if report.Applied {
		t.Fatal("expected report.Applied == false on dry run")
	}
	if report.RecordsCount != 3 || report.CompletedCount != 2 || report.FailedCount != 1 || report.AcceptedVerifiedCount != 1 {
		t.Fatalf("unexpected dry run report counts: %+v", report)
	}
	if report.RecordsSHA256 == "" {
		t.Fatal("expected non-empty RecordsSHA256")
	}

	// Verify scope is unchanged after dry run
	scopeAfterDryRun, _, _ := readBucketDump(t, dir)
	if scopeAfterDryRun != fromScope {
		t.Fatalf("scope changed during dry run: expected %s, got %s", fromScope, scopeAfterDryRun)
	}

	// 2. Apply migration
	opts.Apply = true
	reportApply, err := Migrate(opts)
	if err != nil {
		t.Fatalf("apply Migrate failed: %v", err)
	}
	if !reportApply.Applied {
		t.Fatal("expected reportApply.Applied == true on apply")
	}
	if reportApply.ToScope != toScope {
		t.Fatalf("expected ToScope %s, got %s", toScope, reportApply.ToScope)
	}
	if reportApply.RecordsSHA256 != report.RecordsSHA256 {
		t.Fatalf("records SHA256 changed between dry run and apply: %s vs %s", report.RecordsSHA256, reportApply.RecordsSHA256)
	}

	// 3. Verify scope is updated to toScope and every record byte is 100% identical
	scopeAfterApply, recordsAfter, pendingAfter := readBucketDump(t, dir)
	if scopeAfterApply != toScope {
		t.Fatalf("scope after apply mismatch: expected %s, got %s", toScope, scopeAfterApply)
	}
	if pendingAfter != 0 {
		t.Fatalf("pending bucket not empty: %d", pendingAfter)
	}
	if len(recordsAfter) != len(recordsBefore) {
		t.Fatalf("records count mismatch: before=%d, after=%d", len(recordsBefore), len(recordsAfter))
	}
	for k, beforeBytes := range recordsBefore {
		afterBytes, ok := recordsAfter[k]
		if !ok {
			t.Fatalf("record %s missing after migration", k)
		}
		if !bytes.Equal(beforeBytes, afterBytes) {
			t.Fatalf("record %s bytes changed during migration", k)
		}
	}

	// 4. Verify Journal.Open succeeds with the new scope
	jNew, err := Open(dir, toScope)
	if err != nil {
		t.Fatalf("Open with new scope failed: %v", err)
	}
	defer closeJournal(t, jNew)
}

func TestMigrate_WrongScopeRejected(t *testing.T) {
	dir := testPrivateDir(t)
	nodeID := "macair"
	fromURL := "ws://127.0.0.1:8790/v1/daemon"
	toURL := "wss://leader.taoai.site/v1/daemon"
	sockPath := "/tmp/test.sock"

	// Create journal with a mismatched scope
	createTestJournalWithRecords(t, dir, "some-other-scope", nil)

	opts := MigrationOptions{
		StateDir:   dir,
		NodeID:     nodeID,
		SocketPath: sockPath,
		FromURL:    fromURL,
		ToURL:      toURL,
		Apply:      false,
	}
	_, err := Migrate(opts)
	if err == nil || !strings.Contains(err.Error(), "existing command journal scope mismatch") {
		t.Fatalf("expected scope mismatch error, got: %v", err)
	}
}

func TestMigrate_PendingRejected(t *testing.T) {
	dir := testPrivateDir(t)
	nodeID := "macair"
	fromURL := "ws://127.0.0.1:8790/v1/daemon"
	toURL := "wss://leader.taoai.site/v1/daemon"
	sockPath := "/tmp/test.sock"
	fromScope, err := ScopeDigest(nodeID, fromURL, sockPath)
	if err != nil {
		t.Fatal(err)
	}

	// Create journal with an unacknowledged record (which leaves key in pending-v1)
	entries := []Entry{
		{
			Finished:     true,
			Acknowledged: false, // will leave in pending
			Result: protocol.DaemonResultMessage{
				Type:      "result",
				CommandID: "cmd-pending",
				Status:    protocol.StatusCompleted,
				TurnID:    "t-p",
			},
		},
	}
	createTestJournalWithRecords(t, dir, fromScope, entries)

	opts := MigrationOptions{
		StateDir:   dir,
		NodeID:     nodeID,
		SocketPath: sockPath,
		FromURL:    fromURL,
		ToURL:      toURL,
		Apply:      true,
	}
	_, err = Migrate(opts)
	if err == nil || !strings.Contains(err.Error(), "migration requires zero pending") {
		t.Fatalf("expected pending rejection error, got: %v", err)
	}
}

func TestMigrate_UnfinishedRejected(t *testing.T) {
	dir := testPrivateDir(t)
	nodeID := "macair"
	fromURL := "ws://127.0.0.1:8790/v1/daemon"
	toURL := "wss://leader.taoai.site/v1/daemon"
	sockPath := "/tmp/test.sock"
	fromScope, err := ScopeDigest(nodeID, fromURL, sockPath)
	if err != nil {
		t.Fatal(err)
	}

	j, err := Open(dir, fromScope)
	if err != nil {
		t.Fatal(err)
	}
	cmd := testCommand("cmd-unfin", "prompt")
	if _, _, err := j.Begin(cmd); err != nil {
		t.Fatal(err)
	}
	// We manually close without Finish; Open would recover it to uncertain on startup,
	// but let's test if raw unfinished entry in records is caught
	if err := j.Close(); err != nil {
		t.Fatal(err)
	}

	opts := MigrationOptions{
		StateDir:   dir,
		NodeID:     nodeID,
		SocketPath: sockPath,
		FromURL:    fromURL,
		ToURL:      toURL,
		Apply:      false,
	}
	_, err = Migrate(opts)
	if err == nil {
		t.Fatal("expected error on unfinished/pending command")
	}
}

func TestMigrate_UncertainRejected(t *testing.T) {
	dir := testPrivateDir(t)
	nodeID := "macair"
	fromURL := "ws://127.0.0.1:8790/v1/daemon"
	toURL := "wss://leader.taoai.site/v1/daemon"
	sockPath := "/tmp/test.sock"
	fromScope, err := ScopeDigest(nodeID, fromURL, sockPath)
	if err != nil {
		t.Fatal(err)
	}

	entries := []Entry{
		{
			Finished:     true,
			Acknowledged: true,
			Result: protocol.DaemonResultMessage{
				Type:      "result",
				CommandID: "cmd-uncertain",
				Status:    protocol.StatusUncertain,
				TurnID:    "t-u",
			},
		},
	}
	createTestJournalWithRecords(t, dir, fromScope, entries)

	opts := MigrationOptions{
		StateDir:   dir,
		NodeID:     nodeID,
		SocketPath: sockPath,
		FromURL:    fromURL,
		ToURL:      toURL,
		Apply:      false,
	}
	_, err = Migrate(opts)
	if err == nil || !strings.Contains(err.Error(), "cannot migrate uncertain commands") {
		t.Fatalf("expected uncertain rejection, got: %v", err)
	}
}

func TestMigrate_AcceptedWithoutReceiptRejected(t *testing.T) {
	dir := testPrivateDir(t)
	nodeID := "macair"
	fromURL := "ws://127.0.0.1:8790/v1/daemon"
	toURL := "wss://leader.taoai.site/v1/daemon"
	sockPath := "/tmp/test.sock"
	fromScope, err := ScopeDigest(nodeID, fromURL, sockPath)
	if err != nil {
		t.Fatal(err)
	}

	entries := []Entry{
		{
			Finished:     true,
			Acknowledged: true,
			Result: protocol.DaemonResultMessage{
				Type:      "result",
				CommandID: "cmd-acc",
				Status:    protocol.StatusAccepted,
				TurnID:    "t-acc",
			},
		},
	}
	createTestJournalWithRecords(t, dir, fromScope, entries)

	opts := MigrationOptions{
		StateDir:   dir,
		NodeID:     nodeID,
		SocketPath: sockPath,
		FromURL:    fromURL,
		ToURL:      toURL,
		Receipts:   nil, // no receipts provided
		Apply:      false,
	}
	_, err = Migrate(opts)
	if err == nil || !strings.Contains(err.Error(), "terminal controller receipt required") {
		t.Fatalf("expected accepted without receipt rejection, got: %v", err)
	}
}

func TestMigrate_AcceptedWithMismatchedReceiptRejected(t *testing.T) {
	dir := testPrivateDir(t)
	nodeID := "macair"
	fromURL := "ws://127.0.0.1:8790/v1/daemon"
	toURL := "wss://leader.taoai.site/v1/daemon"
	sockPath := "/tmp/test.sock"
	fromScope, err := ScopeDigest(nodeID, fromURL, sockPath)
	if err != nil {
		t.Fatal(err)
	}

	entries := []Entry{
		{
			Finished:     true,
			Acknowledged: true,
			Result: protocol.DaemonResultMessage{
				Type:      "result",
				CommandID: "cmd-acc",
				Status:    protocol.StatusAccepted,
				TurnID:    "t-acc",
			},
		},
	}
	createTestJournalWithRecords(t, dir, fromScope, entries)

	// Case 1: wrong turnId
	receiptsWrongTurn := []TerminalReceipt{
		{
			CommandID: "cmd-acc",
			NodeID:    nodeID,
			TurnID:    "t-wrong",
			Status:    protocol.StatusCompleted,
		},
	}
	opts := MigrationOptions{
		StateDir:   dir,
		NodeID:     nodeID,
		SocketPath: sockPath,
		FromURL:    fromURL,
		ToURL:      toURL,
		Receipts:   receiptsWrongTurn,
		Apply:      false,
	}
	_, err = Migrate(opts)
	if err == nil || !strings.Contains(err.Error(), "receipt turnId mismatch") {
		t.Fatalf("expected turnId mismatch rejection, got: %v", err)
	}

	// Case 2: wrong nodeId
	receiptsWrongNode := []TerminalReceipt{
		{
			CommandID: "cmd-acc",
			NodeID:    "other-node",
			TurnID:    "t-acc",
			Status:    protocol.StatusCompleted,
		},
	}
	opts.Receipts = receiptsWrongNode
	_, err = Migrate(opts)
	if err == nil || !strings.Contains(err.Error(), "receipt nodeId mismatch") {
		t.Fatalf("expected nodeId mismatch rejection, got: %v", err)
	}

	// Case 3: receipt status not completed/failed
	receiptsNotTerminal := []TerminalReceipt{
		{
			CommandID: "cmd-acc",
			NodeID:    nodeID,
			TurnID:    "t-acc",
			Status:    protocol.StatusAccepted,
		},
	}
	opts.Receipts = receiptsNotTerminal
	_, err = Migrate(opts)
	if err == nil || !strings.Contains(err.Error(), "receipt has non-terminal status") {
		t.Fatalf("expected non-terminal status rejection, got: %v", err)
	}
}

func TestMigrate_NonExistentFileNotCreated(t *testing.T) {
	dir := testPrivateDir(t)
	nodeID := "macair"
	fromURL := "ws://127.0.0.1:8790/v1/daemon"
	toURL := "wss://leader.taoai.site/v1/daemon"
	sockPath := "/tmp/test.sock"

	// Directory exists, but commands.db does not exist
	dbPath := filepath.Join(dir, FileName)
	if _, err := os.Stat(dbPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("expected commands.db not to exist")
	}

	opts := MigrationOptions{
		StateDir:   dir,
		NodeID:     nodeID,
		SocketPath: sockPath,
		FromURL:    fromURL,
		ToURL:      toURL,
		Apply:      true,
	}
	_, err := Migrate(opts)
	if err == nil || !strings.Contains(err.Error(), "refusing to create") {
		t.Fatalf("expected refusing to create error, got: %v", err)
	}

	// Confirm file was NOT created
	if _, err := os.Stat(dbPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("commands.db was created when it should not have been")
	}
}

func TestParseReceiptsJSON_StrictArray(t *testing.T) {
	// Valid strict array
	valid := `[{"commandId":"c1","nodeId":"n1","turnId":"t1","status":"completed"}]`
	parsed, err := ParseReceiptsJSON([]byte(valid))
	if err != nil {
		t.Fatalf("expected valid parse, got: %v", err)
	}
	if len(parsed) != 1 || parsed[0].CommandID != "c1" {
		t.Fatalf("unexpected parsed: %+v", parsed)
	}

	// Object rejected
	invalidObj := `{"commands":[{"commandId":"c1","nodeId":"n1","turnId":"t1","status":"completed"}]}`
	if _, err := ParseReceiptsJSON([]byte(invalidObj)); err == nil {
		t.Fatal("expected object to be rejected")
	}

	// Unknown field rejected
	invalidExtra := `[{"commandId":"c1","nodeId":"n1","turnId":"t1","status":"completed","extra":"bad"}]`
	if _, err := ParseReceiptsJSON([]byte(invalidExtra)); err == nil {
		t.Fatal("expected extra fields to be rejected")
	}
}

func TestParseReceiptsJSON_TrailingDataRejected(t *testing.T) {
	trailing := `[{"commandId":"c1","nodeId":"n1","turnId":"t1","status":"completed"}]{"extra":1}`
	if _, err := ParseReceiptsJSON([]byte(trailing)); err == nil || !strings.Contains(err.Error(), "trailing data") {
		t.Fatalf("expected trailing data error, got: %v", err)
	}
}
