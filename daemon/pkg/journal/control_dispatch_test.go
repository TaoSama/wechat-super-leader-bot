package journal

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	bolt "go.etcd.io/bbolt"
)

func TestControlDispatchInspectionRequiresDurableSessionAndTurn(t *testing.T) {
	dir := testPrivateDir(t)
	j, err := Open(dir, dispatchTestScope)
	if err != nil {
		t.Fatal(err)
	}
	cmd := testCommand("control-command", "task")
	cmd.SendRoute = protocol.RouteControlSocket
	if _, _, err := j.Begin(cmd); err != nil {
		t.Fatal(err)
	}
	result := protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID, TurnID: "exact-turn", Status: protocol.StatusAccepted}
	if _, err := j.ReadDispatch(cmd.CommandID, cmd.SessionID, result.TurnID); !errors.Is(err, ErrDispatchIdentity) {
		t.Fatalf("unfinished claim granted inspection: %v", err)
	}
	if err := j.Finish(result); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][3]string{
		{"missing", cmd.SessionID, result.TurnID},
		{cmd.CommandID, "other-session", result.TurnID},
		{cmd.CommandID, cmd.SessionID, "other-turn"},
	} {
		if _, err := j.ReadDispatch(args[0], args[1], args[2]); !errors.Is(err, ErrDispatchIdentity) {
			t.Fatalf("inexact identity granted inspection: %v", err)
		}
	}
	want := protocol.DispatchIdentity{Route: protocol.RouteControlSocket, SessionID: cmd.SessionID}
	if got, err := j.ReadDispatch(cmd.CommandID, cmd.SessionID, result.TurnID); err != nil || got != want {
		t.Fatalf("exact control route unavailable: %+v error=%v", got, err)
	}
	if err := j.Ack(protocol.ResultAckMessage{CommandID: cmd.CommandID, TurnID: result.TurnID, Status: result.Status}); err != nil {
		t.Fatal(err)
	}
	closeJournal(t, j)
	j, err = Open(dir, dispatchTestScope)
	if err != nil {
		t.Fatal(err)
	}
	defer closeJournal(t, j)
	if got, err := j.ReadDispatch(cmd.CommandID, cmd.SessionID, result.TurnID); err != nil || got != want {
		t.Fatalf("ACK/restart lost exact control route: %+v error=%v", got, err)
	}
	if err := j.db.Update(func(tx *bolt.Tx) error {
		bucket := tx.Bucket(recordsBucket)
		entry, err := decode([]byte(cmd.CommandID), bucket.Get([]byte(cmd.CommandID)))
		if err != nil {
			return err
		}
		entry.SessionID = ""
		raw, err := json.Marshal(entry)
		if err != nil {
			return err
		}
		return bucket.Put([]byte(cmd.CommandID), raw)
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := j.ReadDispatch(cmd.CommandID, cmd.SessionID, result.TurnID); !errors.Is(err, ErrDispatchIdentity) {
		t.Fatalf("historical missing session binding was guessed: %v", err)
	}
}
