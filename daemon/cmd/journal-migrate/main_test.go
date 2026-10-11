package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/journal"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func testCLIJournal(t *testing.T, dir, scope string) {
	t.Helper()
	j, err := journal.Open(dir, scope)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	cmd := protocol.ControllerCommandMessage{
		Type:      "command",
		CommandID: "cmd-cli-1",
		NodeID:    "demoair",
		SessionID: "sess-1",
		Action:    protocol.ActionSend,
		Prompt:    "test",
	}
	if _, _, err := j.Begin(cmd); err != nil {
		t.Fatalf("Begin failed: %v", err)
	}
	res := protocol.DaemonResultMessage{
		Type:      "result",
		CommandID: "cmd-cli-1",
		Status:    protocol.StatusCompleted,
		TurnID:    "turn-cli-1",
	}
	if err := j.Finish(res); err != nil {
		t.Fatalf("Finish failed: %v", err)
	}
	ack := protocol.ResultAckMessage{
		Type:      "ack",
		CommandID: "cmd-cli-1",
		TurnID:    "turn-cli-1",
		Status:    protocol.StatusCompleted,
	}
	if err := j.Ack(ack); err != nil {
		t.Fatalf("Ack failed: %v", err)
	}
	if err := j.Close(); err != nil {
		t.Fatalf("Close failed: %v", err)
	}
}

func TestCLI_DryRunAndApply(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}

	nodeID := "demoair"
	fromURL := "ws://127.0.0.1:8790/v1/daemon"
	toURL := "wss://leader.example.com/v1/daemon"
	sockPath := "/tmp/test.sock"

	fromScope, err := journal.ScopeDigest(nodeID, fromURL, sockPath)
	if err != nil {
		t.Fatal(err)
	}
	testCLIJournal(t, dir, fromScope)

	// 1. Dry run CLI
	var stdout, stderr bytes.Buffer
	code := run([]string{
		"-state-dir", dir,
		"-node-id", nodeID,
		"-sock", sockPath,
		"-from", fromURL,
		"-to", toURL,
	}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("cli dry run returned %d, stderr: %s", code, stderr.String())
	}
	var rep journal.MigrationReport
	if err := json.Unmarshal(stdout.Bytes(), &rep); err != nil {
		t.Fatalf("json decode cli stdout failed: %v, raw: %s", err, stdout.String())
	}
	if rep.Applied {
		t.Fatal("expected rep.Applied == false")
	}
	if rep.RecordsCount != 1 || rep.CompletedCount != 1 {
		t.Fatalf("unexpected counts: %+v", rep)
	}

	// 2. Apply CLI
	stdout.Reset()
	stderr.Reset()
	code = run([]string{
		"-state-dir", dir,
		"-node-id", nodeID,
		"-sock", sockPath,
		"-from", fromURL,
		"-to", toURL,
		"-apply",
	}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("cli apply returned %d, stderr: %s", code, stderr.String())
	}
	if err := json.Unmarshal(stdout.Bytes(), &rep); err != nil {
		t.Fatalf("json decode cli stdout failed: %v, raw: %s", err, stdout.String())
	}
	if !rep.Applied {
		t.Fatal("expected rep.Applied == true")
	}

	// Verify journal opens with toScope now
	toScope, err := journal.ScopeDigest(nodeID, toURL, sockPath)
	if err != nil {
		t.Fatal(err)
	}
	j, err := journal.Open(dir, toScope)
	if err != nil {
		t.Fatalf("Open with new toScope failed: %v", err)
	}
	_ = j.Close()
}
