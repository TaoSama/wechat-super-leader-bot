package client

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/journal"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	bolt "go.etcd.io/bbolt"
)

type emptyResultAdapter struct {
	state string
	err   error
	reads atomic.Int32
}

func TestAcknowledgedRawPlaceholderCannotReviveEmptyOutputAfterRestart(t *testing.T) {
	cfg := persistenceConfig(t.TempDir())
	d, err := OpenDaemon(cfg, &emptyResultAdapter{})
	if err != nil {
		t.Fatal(err)
	}
	cmd := persistenceCommand(time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano))
	cmd.Action, cmd.Prompt = protocol.ActionRead, ""
	result := d.ExecuteCommand(context.Background(), cmd)
	if result.Status != protocol.StatusCompleted {
		t.Fatalf("read failed: %+v", result)
	}
	if err := d.ackResult(protocol.ResultAckMessage{CommandID: cmd.CommandID, Status: result.Status}); err != nil {
		t.Fatal(err)
	}
	closeDaemon(t, d)
	db, err := bolt.Open(filepath.Join(cfg.StateDir, journal.FileName), 0600, &bolt.Options{Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	updateErr := db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket([]byte("records-v1"))
		var raw map[string]json.RawMessage
		if err := json.Unmarshal(bucket.Get([]byte(cmd.CommandID)), &raw); err != nil {
			return err
		}
		var receipt map[string]json.RawMessage
		if err := json.Unmarshal(raw["result"], &receipt); err != nil {
			return err
		}
		receipt["output"] = json.RawMessage(`""`)
		encodedReceipt, err := json.Marshal(receipt)
		if err != nil {
			return err
		}
		raw["result"] = encodedReceipt
		encoded, err := json.Marshal(raw)
		if err != nil {
			return err
		}
		return bucket.Put([]byte(cmd.CommandID), encoded)
	})
	if err := errors.Join(updateErr, db.Close()); err != nil {
		t.Fatal(err)
	}
	restartedAdapter := &emptyResultAdapter{}
	d, err = OpenDaemon(cfg, restartedAdapter)
	if err != nil {
		t.Fatal(err)
	}
	defer closeDaemon(t, d)
	// Duplicate requests return only the retained status, not a fabricated body.
	replay := d.ExecuteCommand(context.Background(), cmd)
	requireResultOutput(t, replay, false)
	if replay.Status != result.Status || replay.CommandID != result.CommandID || restartedAdapter.reads.Load() != 0 {
		t.Fatalf("duplicate receipt reexecuted or lost identity: %+v reads=%d", replay, restartedAdapter.reads.Load())
	}
	if err := d.flushResults(func(any) error { return errors.New("ACKed result reentered outbox") }); err != nil {
		t.Fatal(err)
	}
}

func (*emptyResultAdapter) DiscoverSessions(context.Context) ([]protocol.Session, error) {
	return nil, nil
}
func (a *emptyResultAdapter) ReadSession(context.Context, string) (string, error) {
	a.reads.Add(1)
	return "", nil
}
func (*emptyResultAdapter) SendPrompt(context.Context, string, string) (string, error) {
	return "", errors.New("unexpected send")
}
func (a *emptyResultAdapter) InspectTurn(context.Context, string, string) (codex.TurnObservation, error) {
	return codex.TurnObservation{Status: a.state}, a.err
}

func requireResultOutput(t *testing.T, result protocol.DaemonResultMessage, present bool) {
	t.Helper()
	// The actual connection write path uses this encoder, not an alternate DTO.
	data, err := encodeControllerMessage(result)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]json.RawMessage
	if err := json.Unmarshal(data, &wire); err != nil {
		t.Fatal(err)
	}
	output, exists := wire["output"]
	if exists != present || present && string(output) != `""` {
		t.Fatalf("unsafe output presence want=%t: %s", present, data)
	}
}

func TestSuccessfulEmptyReadPersistsAndReplaysExplicitOutput(t *testing.T) {
	cfg := persistenceConfig(t.TempDir())
	d, err := OpenDaemon(cfg, &emptyResultAdapter{})
	if err != nil {
		t.Fatal(err)
	}
	cmd := persistenceCommand(time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano))
	cmd.Action, cmd.Prompt = protocol.ActionRead, ""
	result := d.ExecuteCommand(context.Background(), cmd)
	if result.Status != protocol.StatusCompleted {
		t.Fatalf("read failed: %+v", result)
	}
	requireResultOutput(t, result, true)
	closeDaemon(t, d)
	d, err = OpenDaemon(cfg, &emptyResultAdapter{})
	if err != nil {
		t.Fatal(err)
	}
	defer closeDaemon(t, d)
	requireResultOutput(t, d.ExecuteCommand(context.Background(), cmd), true)
	count := 0
	if err := d.flushResults(func(value any) error {
		count++
		requireResultOutput(t, value.(protocol.DaemonResultMessage), true)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("expected one durable receipt, got %d", count)
	}
}

func TestExactEmptyTurnResultIsExplicitButUnknownStatesOmitOutput(t *testing.T) {
	for _, tc := range []struct {
		state   string
		err     error
		status  protocol.DaemonResultStatus
		present bool
	}{
		{"completed", nil, protocol.StatusCompleted, true},
		{"inProgress", nil, protocol.StatusAccepted, false},
		{"failed", nil, protocol.StatusFailed, false},
		{"interrupted", nil, protocol.StatusFailed, false},
		{"unknown", nil, protocol.StatusUncertain, false},
		{"completed", errors.New("unavailable"), protocol.StatusUncertain, false},
	} {
		t.Run(tc.state+string(tc.status), func(t *testing.T) {
			d := NewDaemon(&config.Config{NodeID: "node"}, &emptyResultAdapter{state: tc.state, err: tc.err})
			result := d.InspectTurn(context.Background(), protocol.InspectTurnMessage{Type: "inspect_turn", CommandID: "command",
				NodeID: "node", SessionID: "session", TurnID: "target"})
			if result.Status != tc.status {
				t.Fatalf("unexpected status: %+v", result)
			}
			requireResultOutput(t, result, tc.present)
		})
	}
}

func TestUnavailableJournalAndTerminalInputDoNotInventOutput(t *testing.T) {
	for _, result := range []protocol.DaemonResultMessage{
		journalFailure("command"), terminalFailure("command", "uncertain", true),
		terminalFailure("command", "failed", false),
		{Type: "result", CommandID: "command", Status: protocol.StatusInputWritten},
	} {
		requireResultOutput(t, result, false)
	}
}
