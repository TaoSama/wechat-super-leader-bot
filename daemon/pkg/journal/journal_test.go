package journal

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	bolt "go.etcd.io/bbolt"
)

func closeJournal(t *testing.T, j *Journal) {
	t.Helper()
	if err := j.Close(); err != nil {
		t.Error(err)
	}
}

func testPrivateDir(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "state")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatalf("failed to create test dir: %v", err)
	}
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatalf("failed to chmod test dir: %v", err)
	}
	return dir
}

func testCommand(id, prompt string) protocol.ControllerCommandMessage {
	return protocol.ControllerCommandMessage{
		Type:      "command",
		CommandID: id,
		NodeID:    "node-test",
		SessionID: "sess-test",
		Action:    protocol.ActionSend,
		Prompt:    prompt,
		ExpiresAt: time.Now().Add(time.Hour).Format(time.RFC3339),
	}
}

// Begin/Finish/close/reopen/Unacked 恢复 accepted turn
func TestJournal_BeginFinishCloseReopenUnackedAccepted(t *testing.T) {
	dir := testPrivateDir(t)
	scope := "node-test/controller/sock"

	j1, err := Open(dir, scope)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}

	cmd := testCommand("cmd-accept", "run turn")
	entry, created, err := j1.Begin(cmd)
	if err != nil {
		t.Fatalf("Begin failed: %v", err)
	}
	if !created {
		t.Fatalf("expected created=true for new command")
	}
	if entry.Finished {
		t.Fatalf("expected entry not finished initially")
	}

	result := protocol.DaemonResultMessage{
		Type:      "result",
		CommandID: cmd.CommandID,
		Status:    protocol.StatusAccepted,
		TurnID:    "turn-123",
		Output:    "turn accepted and processing",
	}
	if err := j1.Finish(result); err != nil {
		t.Fatalf("Finish failed: %v", err)
	}

	if err := j1.Close(); err != nil {
		t.Fatalf("Close failed: %v", err)
	}

	// Reopen and check Unacked recovers the accepted result
	j2, err := Open(dir, scope)
	if err != nil {
		t.Fatalf("Reopen failed: %v", err)
	}
	defer closeJournal(t, j2)

	unacked, err := j2.Unacked()
	if err != nil {
		t.Fatalf("Unacked failed: %v", err)
	}
	if len(unacked) != 1 {
		t.Fatalf("expected 1 unacked result, got %d", len(unacked))
	}
	got := unacked[0]
	if got.CommandID != cmd.CommandID || got.Status != protocol.StatusAccepted || got.TurnID != "turn-123" {
		t.Fatalf("unexpected unacked result: %+v", got)
	}
	if got.Output != "turn accepted and processing" {
		t.Fatalf("unexpected unacked output: %q", got.Output)
	}
}

// 仅 Begin 就 close 重启恢复 uncertain，重复 Begin 不会 created
func TestJournal_BeginCrashReopenUncertainAndNoRecreate(t *testing.T) {
	dir := testPrivateDir(t)
	scope := "node-test/controller/sock"

	j1, err := Open(dir, scope)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}

	cmd := testCommand("cmd-crash", "run but crash")
	entry, created, err := j1.Begin(cmd)
	if err != nil {
		t.Fatalf("Begin failed: %v", err)
	}
	if !created {
		t.Fatalf("expected created=true")
	}
	if entry.Finished {
		t.Fatalf("entry should not be finished before crash")
	}

	// Close without Finish (simulating daemon restart/crash after claim)
	if err := j1.Close(); err != nil {
		t.Fatalf("Close failed: %v", err)
	}

	// Reopen recovers unfinished claim as uncertain
	j2, err := Open(dir, scope)
	if err != nil {
		t.Fatalf("Reopen failed: %v", err)
	}
	defer closeJournal(t, j2)

	unacked, err := j2.Unacked()
	if err != nil {
		t.Fatalf("Unacked failed: %v", err)
	}
	if len(unacked) != 1 {
		t.Fatalf("expected 1 unacked result after crash recovery, got %d", len(unacked))
	}
	if unacked[0].Status != protocol.StatusUncertain {
		t.Fatalf("expected status %v, got %v", protocol.StatusUncertain, unacked[0].Status)
	}

	// Duplicate Begin must not create new claim
	entry2, created2, err := j2.Begin(cmd)
	if err != nil {
		t.Fatalf("second Begin failed: %v", err)
	}
	if created2 {
		t.Fatalf("second Begin must return created=false")
	}
	if !entry2.Finished || entry2.Result.Status != protocol.StatusUncertain {
		t.Fatalf("expected recovered uncertain entry from duplicate Begin, got %+v", entry2)
	}
}

// Ack 错误 turn/status 保留，匹配 ack 后 unacked 为空但 Lookup 仍 found（output/error允许清空）
func TestJournal_AckValidationAndOutputClearing(t *testing.T) {
	dir := testPrivateDir(t)
	scope := "node-test/controller/sock"

	j, err := Open(dir, scope)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer closeJournal(t, j)

	cmd := testCommand("cmd-ack", "task")
	if _, _, err := j.Begin(cmd); err != nil {
		t.Fatalf("Begin failed: %v", err)
	}

	result := protocol.DaemonResultMessage{
		Type:      "result",
		CommandID: cmd.CommandID,
		Status:    protocol.StatusCompleted,
		TurnID:    "turn-correct",
		Output:    "secret output that should be purged",
		Error:     "",
	}
	if err := j.Finish(result); err != nil {
		t.Fatalf("Finish failed: %v", err)
	}

	// Ack with wrong turnID: ignored/retained
	ackWrongTurn := protocol.ResultAckMessage{
		Type:      "ack",
		CommandID: cmd.CommandID,
		TurnID:    "turn-wrong",
		Status:    protocol.StatusCompleted,
	}
	if err := j.Ack(ackWrongTurn); err != nil {
		t.Fatalf("Ack with wrong turn should not return error: %v", err)
	}
	unacked, err := j.Unacked()
	if err != nil || len(unacked) != 1 {
		t.Fatalf("expected 1 unacked entry retained after wrong turnID ack, got %d, err=%v", len(unacked), err)
	}

	// Ack with wrong status: ignored/retained
	ackWrongStatus := protocol.ResultAckMessage{
		Type:      "ack",
		CommandID: cmd.CommandID,
		TurnID:    "turn-correct",
		Status:    protocol.StatusFailed,
	}
	if err := j.Ack(ackWrongStatus); err != nil {
		t.Fatalf("Ack with wrong status should not return error: %v", err)
	}
	unacked, err = j.Unacked()
	if err != nil || len(unacked) != 1 {
		t.Fatalf("expected 1 unacked entry retained after wrong status ack, got %d, err=%v", len(unacked), err)
	}

	// Correct Ack matching turnID and status
	ackCorrect := protocol.ResultAckMessage{
		Type:      "ack",
		CommandID: cmd.CommandID,
		TurnID:    "turn-correct",
		Status:    protocol.StatusCompleted,
	}
	if err := j.Ack(ackCorrect); err != nil {
		t.Fatalf("Ack correct failed: %v", err)
	}

	// unacked must now be empty
	unacked, err = j.Unacked()
	if err != nil {
		t.Fatalf("Unacked failed: %v", err)
	}
	if len(unacked) != 0 {
		t.Fatalf("expected 0 unacked entries after valid ack, got %d", len(unacked))
	}

	// Lookup still found, acknowledged=true, and output/error cleared
	entry, found, err := j.Lookup(cmd)
	if err != nil {
		t.Fatalf("Lookup failed: %v", err)
	}
	if !found {
		t.Fatalf("expected entry still found in records after ack")
	}
	if !entry.Acknowledged {
		t.Fatalf("expected entry.Acknowledged == true")
	}
	if entry.Result.TurnID != "turn-correct" || entry.Result.Status != protocol.StatusCompleted {
		t.Fatalf("unexpected status/turn receipt: %+v", entry.Result)
	}
	if entry.Result.Output != "" || entry.Result.Error != "" {
		t.Fatalf("expected output and error cleared after ack, got output=%q, error=%q", entry.Result.Output, entry.Result.Error)
	}
}

// 变更 payload 冲突
func TestJournal_PayloadConflict(t *testing.T) {
	dir := testPrivateDir(t)
	scope := "node-test/controller/sock"

	j, err := Open(dir, scope)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer closeJournal(t, j)

	cmd1 := testCommand("cmd-conflict", "prompt original")
	if _, _, err := j.Begin(cmd1); err != nil {
		t.Fatalf("Begin cmd1 failed: %v", err)
	}

	// Same command ID but different prompt (different fingerprint)
	cmd2 := testCommand("cmd-conflict", "prompt changed")
	_, _, err = j.Begin(cmd2)
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("expected ErrConflict on Begin with different payload, got %v", err)
	}

	_, _, err = j.Lookup(cmd2)
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("expected ErrConflict on Lookup with different payload, got %v", err)
	}
}

// 同目录第二实例锁拒绝
func TestJournal_LockExclusion(t *testing.T) {
	dir := testPrivateDir(t)
	scope := "node-test/controller/sock"

	j1, err := Open(dir, scope)
	if err != nil {
		t.Fatalf("Open j1 failed: %v", err)
	}
	defer closeJournal(t, j1)

	// Second instance should fail due to bbolt database file lock timeout
	j2, err := Open(dir, scope)
	if err == nil {
		closeJournal(t, j2)
		t.Fatalf("expected second Open on same directory to fail with lock error")
	}
	if !strings.Contains(err.Error(), "open command journal") {
		t.Fatalf("expected open command journal error, got %v", err)
	}
}

// scope 不同拒绝
func TestJournal_ScopeMismatch(t *testing.T) {
	dir := testPrivateDir(t)

	j1, err := Open(dir, "scope-A")
	if err != nil {
		t.Fatalf("Open j1 failed: %v", err)
	}
	if err := j1.Close(); err != nil {
		t.Fatalf("Close j1 failed: %v", err)
	}

	// Opening existing journal with a different scope must fail
	j2, err := Open(dir, "scope-B")
	if err == nil {
		closeJournal(t, j2)
		t.Fatalf("expected Open with mismatched scope to fail")
	}
	if !strings.Contains(err.Error(), "belongs to a different node/controller/socket scope") {
		t.Fatalf("expected scope mismatch error, got %v", err)
	}
}

// 0600/0700 与 symlink/宽松权限拒绝
func TestJournal_PermissionsAndSymlinkRejection(t *testing.T) {
	scope := "node-test/controller/sock"

	// 1. Relative directory path rejected
	if _, err := Open("relative/dir", scope); err == nil {
		t.Fatalf("expected error for relative directory path")
	}

	// 2. Empty scope rejected
	baseDir := testPrivateDir(t)
	if _, err := Open(baseDir, ""); err == nil {
		t.Fatalf("expected error for empty scope")
	}

	// 3. Relaxed directory permissions (0755) rejected
	dir755 := filepath.Join(t.TempDir(), "dir755")
	if err := os.MkdirAll(dir755, 0755); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}
	if err := os.Chmod(dir755, 0755); err != nil {
		t.Fatalf("chmod failed: %v", err)
	}
	if _, err := Open(dir755, scope); err == nil {
		t.Fatalf("expected error for 0755 directory")
	}

	// 4. Relaxed file permissions (0644) rejected
	dirNormal := testPrivateDir(t)
	j, err := Open(dirNormal, scope)
	if err != nil {
		t.Fatalf("initial Open failed: %v", err)
	}
	if err := j.Close(); err != nil {
		t.Fatalf("Close failed: %v", err)
	}
	dbPath := filepath.Join(dirNormal, FileName)
	if err := os.Chmod(dbPath, 0644); err != nil {
		t.Fatalf("chmod db failed: %v", err)
	}
	if _, err := Open(dirNormal, scope); err == nil {
		t.Fatalf("expected error for 0644 db file")
	}
	// Restore file mode for cleanup
	if err := os.Chmod(dbPath, 0600); err != nil {
		t.Fatal(err)
	}

	// 5. Symlink directory rejected
	targetDir := testPrivateDir(t)
	symlinkDir := filepath.Join(t.TempDir(), "dir-symlink")
	if err := os.Symlink(targetDir, symlinkDir); err != nil {
		t.Fatalf("symlink dir failed: %v", err)
	}
	if _, err := Open(symlinkDir, scope); err == nil {
		t.Fatalf("expected error for symlink directory")
	}

	// 6. Symlink db file rejected
	dirWithSymlinkDB := testPrivateDir(t)
	realDBDir := testPrivateDir(t)
	jReal, err := Open(realDBDir, scope)
	if err != nil {
		t.Fatalf("Open real db failed: %v", err)
	}
	if err := jReal.Close(); err != nil {
		t.Fatalf("Close real db failed: %v", err)
	}
	symlinkDB := filepath.Join(dirWithSymlinkDB, FileName)
	if err := os.Symlink(filepath.Join(realDBDir, FileName), symlinkDB); err != nil {
		t.Fatalf("symlink file failed: %v", err)
	}
	if _, err := Open(dirWithSymlinkDB, scope); err == nil {
		t.Fatalf("expected error for symlink db file")
	}
}

// 损坏 entry / DB fail closed
func TestJournal_CorruptFailClosed(t *testing.T) {
	scope := "node-test/controller/sock"

	// 1. Corrupted bbolt file header/data
	t.Run("CorruptedDBFile", func(t *testing.T) {
		dir := testPrivateDir(t)
		dbPath := filepath.Join(dir, FileName)
		if err := os.WriteFile(dbPath, []byte("invalid non-bbolt garbage content"), 0600); err != nil {
			t.Fatalf("write garbage db failed: %v", err)
		}
		if _, err := Open(dir, scope); err == nil {
			t.Fatalf("expected Open to fail on corrupted db file")
		}
	})

	// 2. Corrupted entry JSON in recordsBucket
	t.Run("CorruptedEntryJSON", func(t *testing.T) {
		dir := testPrivateDir(t)
		j, err := Open(dir, scope)
		if err != nil {
			t.Fatalf("Open failed: %v", err)
		}
		cmd := testCommand("cmd-corrupt-entry", "test")
		if _, _, err := j.Begin(cmd); err != nil {
			t.Fatalf("Begin failed: %v", err)
		}
		if err := j.Close(); err != nil {
			t.Fatalf("Close failed: %v", err)
		}

		// Inject invalid json directly into bbolt records bucket
		dbPath := filepath.Join(dir, FileName)
		db, err := bolt.Open(dbPath, 0600, nil)
		if err != nil {
			t.Fatalf("bolt.Open failed: %v", err)
		}
		err = db.Update(func(tx *bolt.Tx) error {
			return tx.Bucket(recordsBucket).Put([]byte(cmd.CommandID), []byte("{invalid-json"))
		})
		if err != nil {
			t.Fatalf("corrupt write failed: %v", err)
		}
		if err := db.Close(); err != nil {
			t.Fatalf("db close failed: %v", err)
		}

		// Open must fail closed during initialize
		if _, err := Open(dir, scope); err == nil {
			t.Fatalf("expected Open to fail closed on corrupt record entry")
		}
	})

	// 3. Inconsistent pending index (records has unacked entry, but pending bucket lacks it)
	t.Run("InconsistentPendingIndex", func(t *testing.T) {
		dir := testPrivateDir(t)
		j, err := Open(dir, scope)
		if err != nil {
			t.Fatalf("Open failed: %v", err)
		}
		cmd := testCommand("cmd-inconsistent-pending", "test")
		if _, _, err := j.Begin(cmd); err != nil {
			t.Fatalf("Begin failed: %v", err)
		}
		if err := j.Close(); err != nil {
			t.Fatalf("Close failed: %v", err)
		}

		// Delete from pending bucket but keep in recordsBucket unacknowledged
		dbPath := filepath.Join(dir, FileName)
		db, err := bolt.Open(dbPath, 0600, nil)
		if err != nil {
			t.Fatalf("bolt.Open failed: %v", err)
		}
		err = db.Update(func(tx *bolt.Tx) error {
			return tx.Bucket(pendingBucket).Delete([]byte(cmd.CommandID))
		})
		if err != nil {
			t.Fatalf("delete from pending failed: %v", err)
		}
		if err := db.Close(); err != nil {
			t.Fatalf("db close failed: %v", err)
		}

		// Reopen must detect inconsistent pending index and fail
		if _, err := Open(dir, scope); err == nil || !strings.Contains(err.Error(), "pending index is inconsistent") {
			t.Fatalf("expected pending index is inconsistent error, got: %v", err)
		}
	})

	// 4. Inconsistent ack index (pending bucket has key whose record is acknowledged)
	t.Run("InconsistentAckIndex", func(t *testing.T) {
		dir := testPrivateDir(t)
		j, err := Open(dir, scope)
		if err != nil {
			t.Fatalf("Open failed: %v", err)
		}
		cmd := testCommand("cmd-inconsistent-ack", "test")
		if _, _, err := j.Begin(cmd); err != nil {
			t.Fatalf("Begin failed: %v", err)
		}
		res := protocol.DaemonResultMessage{
			Type:      "result",
			CommandID: cmd.CommandID,
			Status:    protocol.StatusCompleted,
			TurnID:    "t-1",
		}
		if err := j.Finish(res); err != nil {
			t.Fatalf("Finish failed: %v", err)
		}
		ack := protocol.ResultAckMessage{
			Type:      "ack",
			CommandID: cmd.CommandID,
			TurnID:    "t-1",
			Status:    protocol.StatusCompleted,
		}
		if err := j.Ack(ack); err != nil {
			t.Fatalf("Ack failed: %v", err)
		}
		if err := j.Close(); err != nil {
			t.Fatalf("Close failed: %v", err)
		}

		// Re-add to pending bucket manually even though record is acknowledged
		dbPath := filepath.Join(dir, FileName)
		db, err := bolt.Open(dbPath, 0600, nil)
		if err != nil {
			t.Fatalf("bolt.Open failed: %v", err)
		}
		err = db.Update(func(tx *bolt.Tx) error {
			return tx.Bucket(pendingBucket).Put([]byte(cmd.CommandID), []byte{1})
		})
		if err != nil {
			t.Fatalf("put to pending failed: %v", err)
		}
		if err := db.Close(); err != nil {
			t.Fatalf("db close failed: %v", err)
		}

		// Reopen must detect inconsistent ack index and fail
		if _, err := Open(dir, scope); err == nil || !strings.Contains(err.Error(), "acknowledgement index is inconsistent") {
			t.Fatalf("expected acknowledgement index is inconsistent error, got: %v", err)
		}
	})
}
