package journal

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	bolt "go.etcd.io/bbolt"
)

const dispatchTestScope = "dispatch-node/controller/control-socket"

func desktopCommand(id string) protocol.ControllerCommandMessage {
	cmd := testCommand(id, "PRIVATE_PROMPT_NEVER_IN_IDENTITY")
	cmd.SendRoute = protocol.RouteDesktopOwner
	return cmd
}

func claimDesktop(t *testing.T, j *Journal, cmd protocol.ControllerCommandMessage) protocol.DispatchIdentity {
	t.Helper()
	entry, created, err := j.Begin(cmd)
	if err != nil || !created || entry.Dispatch == nil {
		t.Fatalf("desktop claim not created: %+v %t %v", entry, created, err)
	}
	if entry.Finished || entry.Dispatch.Route != cmd.SendRoute || entry.Dispatch.SessionID != cmd.SessionID ||
		!validDispatchUUID(entry.Dispatch.ClientUserMessageID) || !validDispatchUUID(entry.Dispatch.RequestID) ||
		entry.Dispatch.ClientUserMessageID == entry.Dispatch.RequestID || entry.Dispatch.OwnerID != "" ||
		entry.Dispatch.ConnectionID != "" || entry.Dispatch.Endpoint != "" {
		t.Fatalf("invalid initial identity: %+v", entry)
	}
	persisted, found, err := j.Lookup(cmd)
	if err != nil || !found || !reflect.DeepEqual(persisted, entry) {
		t.Fatalf("identity not atomically persisted: %+v %t %v", persisted, found, err)
	}
	return *entry.Dispatch
}

func boundDesktopIdentity(identity protocol.DispatchIdentity) protocol.DispatchIdentity {
	identity.OwnerID = "fixture-owner"
	identity.ConnectionID = "fixture-connection"
	identity.Endpoint = "/fixture/private/ipc.sock"
	return identity
}

func TestDesktopDispatchClaimAndLegacyReplay(t *testing.T) {
	j, err := Open(testPrivateDir(t), dispatchTestScope)
	if err != nil {
		t.Fatal(err)
	}
	defer closeJournal(t, j)
	cmd := desktopCommand("desktop-command")
	identity := claimDesktop(t, j, cmd)
	entry, created, err := j.Begin(cmd)
	if err != nil || created || entry.Dispatch == nil || *entry.Dispatch != identity {
		t.Fatalf("duplicate regenerated identity: %+v %t %v", entry, created, err)
	}
	for _, route := range []protocol.SendRoute{"", protocol.RouteControlSocket} {
		legacy := testCommand("legacy-"+string(route), "legacy prompt")
		legacy.SendRoute = route
		entry, created, err := j.Begin(legacy)
		if err != nil || !created || entry.Dispatch != nil {
			t.Fatalf("legacy claim changed: %+v %t %v", entry, created, err)
		}
		if err := j.BindDispatch(legacy, identity); err == nil {
			t.Fatal("legacy claim allowed desktop binding")
		}
		if _, err := j.ReadDispatch(legacy.CommandID, legacy.SessionID, "legacy-turn"); !errors.Is(err, ErrNoDispatch) {
			t.Fatalf("legacy read-only inspection routing unavailable: %v", err)
		}
		if _, created, err := j.Begin(legacy); err != nil || created {
			t.Fatalf("legacy replay guard lost: %t %v", created, err)
		}
	}
	err = j.db.View(func(tx *bolt.Tx) error {
		data := tx.Bucket(recordsBucket).Get([]byte(cmd.CommandID))
		if strings.Contains(string(data), cmd.Prompt) {
			return errors.New("journal dispatch retained prompt")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := j.ReadDispatch("missing", cmd.SessionID, "legacy-turn"); !errors.Is(err, ErrNoDispatch) {
		t.Fatalf("missing desktop identity not distinguished: %v", err)
	}
}

func TestDesktopDispatchBindingValidationAndImmutability(t *testing.T) {
	j, err := Open(testPrivateDir(t), dispatchTestScope)
	if err != nil {
		t.Fatal(err)
	}
	defer closeJournal(t, j)
	cmd := desktopCommand("bind-command")
	claim := claimDesktop(t, j, cmd)
	identity := boundDesktopIdentity(claim)
	for _, tc := range []struct {
		name string
		edit func(*protocol.DispatchIdentity)
	}{
		{"route", func(i *protocol.DispatchIdentity) { i.Route = protocol.RouteControlSocket }},
		{"target", func(i *protocol.DispatchIdentity) { i.SessionID = "another-session" }},
		{"message-id", func(i *protocol.DispatchIdentity) { i.ClientUserMessageID = i.RequestID }},
		{"request-id", func(i *protocol.DispatchIdentity) { i.RequestID = i.ClientUserMessageID }},
		{"bad-uuid", func(i *protocol.DispatchIdentity) { i.RequestID = "not-uuid" }},
		{"owner-empty", func(i *protocol.DispatchIdentity) { i.OwnerID = "" }},
		{"owner-whitespace", func(i *protocol.DispatchIdentity) { i.OwnerID = "owner\u2003bad" }},
		{"connection-empty", func(i *protocol.DispatchIdentity) { i.ConnectionID = "" }},
		{"connection-control", func(i *protocol.DispatchIdentity) { i.ConnectionID = "connection\x01" }},
		{"relative", func(i *protocol.DispatchIdentity) { i.Endpoint = "ipc.sock" }},
		{"abstract", func(i *protocol.DispatchIdentity) { i.Endpoint = "@ipc.sock" }},
		{"root", func(i *protocol.DispatchIdentity) { i.Endpoint = "/" }},
		{"unclean", func(i *protocol.DispatchIdentity) { i.Endpoint = "/fixture/../ipc.sock" }},
		{"endpoint-control", func(i *protocol.DispatchIdentity) { i.Endpoint = "/fixture/ipc\n.sock" }},
		{"endpoint-utf8", func(i *protocol.DispatchIdentity) { i.Endpoint = "/fixture/\xff.sock" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			invalid := identity
			tc.edit(&invalid)
			if err := j.BindDispatch(cmd, invalid); err == nil {
				t.Fatal("invalid binding accepted")
			}
			entry, _, err := j.Lookup(cmd)
			if err != nil || entry.Dispatch == nil || *entry.Dispatch != claim {
				t.Fatalf("invalid bind changed claim: %+v %v", entry, err)
			}
		})
	}
	conflict := cmd
	conflict.Prompt = "changed"
	if err := j.BindDispatch(conflict, identity); !errors.Is(err, ErrConflict) {
		t.Fatalf("payload fingerprint not enforced: %v", err)
	}
	missing := cmd
	missing.CommandID = "missing"
	if err := j.BindDispatch(missing, identity); err == nil {
		t.Fatal("missing claim bound")
	}
	if err := j.BindDispatch(cmd, identity); err != nil {
		t.Fatal(err)
	}
	if err := j.BindDispatch(cmd, identity); err != nil {
		t.Fatalf("same identity not idempotent: %v", err)
	}
	for _, mutate := range []func(*protocol.DispatchIdentity){
		func(i *protocol.DispatchIdentity) { i.OwnerID = "new-owner" },
		func(i *protocol.DispatchIdentity) { i.ConnectionID = "new-connection" },
		func(i *protocol.DispatchIdentity) { i.Endpoint = "/another/ipc.sock" },
	} {
		changed := identity
		mutate(&changed)
		if err := j.BindDispatch(cmd, changed); err == nil {
			t.Fatal("bound identity changed")
		}
	}
	if _, err := j.ReadDispatch(cmd.CommandID, cmd.SessionID, "not-bound-yet"); err == nil || errors.Is(err, ErrNoDispatch) {
		t.Fatal("unfinished desktop claim granted inspection or fallback")
	}
}

func TestDesktopDispatchExactInspectionAndAckPreservation(t *testing.T) {
	dir := testPrivateDir(t)
	j, err := Open(dir, dispatchTestScope)
	if err != nil {
		t.Fatal(err)
	}
	cmd := desktopCommand("inspect-command")
	identity := boundDesktopIdentity(claimDesktop(t, j, cmd))
	if err := j.BindDispatch(cmd, identity); err != nil {
		t.Fatal(err)
	}
	result := protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID, Status: protocol.StatusAccepted, TurnID: "exact-turn", Output: "acknowledged"}
	if err := j.Finish(result); err != nil {
		t.Fatal(err)
	}
	if err := j.BindDispatch(cmd, identity); err == nil {
		t.Fatal("finished claim rebound even with same identity")
	}
	for _, args := range [][3]string{{"missing", cmd.SessionID, result.TurnID}, {cmd.CommandID, "other-session", result.TurnID}, {cmd.CommandID, cmd.SessionID, "other-turn"}, {cmd.CommandID, cmd.SessionID, ""}} {
		if _, err := j.ReadDispatch(args[0], args[1], args[2]); err == nil || args[0] != "missing" && errors.Is(err, ErrNoDispatch) {
			t.Fatal("inexact inspection identity accepted")
		}
	}
	got, err := j.ReadDispatch(cmd.CommandID, cmd.SessionID, result.TurnID)
	if err != nil || got != identity {
		t.Fatalf("exact identity unavailable: %+v %v", got, err)
	}
	if err := j.Ack(protocol.ResultAckMessage{Type: "result_ack", CommandID: cmd.CommandID, Status: result.Status, TurnID: result.TurnID}); err != nil {
		t.Fatal(err)
	}
	closeJournal(t, j)
	j, err = Open(dir, dispatchTestScope)
	if err != nil {
		t.Fatal(err)
	}
	defer closeJournal(t, j)
	got, err = j.ReadDispatch(cmd.CommandID, cmd.SessionID, result.TurnID)
	if err != nil || got != identity {
		t.Fatalf("ACK/restart discarded route: %+v %v", got, err)
	}
	entry, created, err := j.Begin(cmd)
	if err != nil || created || !entry.Acknowledged || entry.Result.Output != "" || entry.Dispatch == nil || *entry.Dispatch != identity {
		t.Fatalf("ACK lost replay guard or retained output: %+v %t %v", entry, created, err)
	}
	if pending, err := j.Unacked(); err != nil || len(pending) != 0 {
		t.Fatalf("ACK did not clear pending receipt: %+v %v", pending, err)
	}
}

func TestDesktopDispatchRestartNeverReopensClaim(t *testing.T) {
	for _, bound := range []bool{false, true} {
		t.Run(map[bool]string{false: "claim-only", true: "bound-before-write"}[bound], func(t *testing.T) {
			dir := testPrivateDir(t)
			j, err := Open(dir, dispatchTestScope)
			if err != nil {
				t.Fatal(err)
			}
			cmd := desktopCommand("restart-command")
			claim := claimDesktop(t, j, cmd)
			identity := boundDesktopIdentity(claim)
			if bound {
				if err := j.BindDispatch(cmd, identity); err != nil {
					t.Fatal(err)
				}
				claim = identity
			}
			closeJournal(t, j)
			j, err = Open(dir, dispatchTestScope)
			if err != nil {
				t.Fatal(err)
			}
			defer closeJournal(t, j)
			entry, created, err := j.Begin(cmd)
			if err != nil || created || !entry.Finished || entry.Result.Status != protocol.StatusUncertain || entry.Dispatch == nil || *entry.Dispatch != claim {
				t.Fatalf("restart authorized replay or regenerated identity: %+v %t %v", entry, created, err)
			}
			if err := j.BindDispatch(cmd, identity); err == nil {
				t.Fatal("recovered claim authorized native write")
			}
			if _, err := j.ReadDispatch(cmd.CommandID, cmd.SessionID, "guessed-turn"); err == nil {
				t.Fatal("restart created a guessed turn binding")
			}
		})
	}
}

func TestDesktopDispatchFinishedUnboundCannotFallback(t *testing.T) {
	j, err := Open(testPrivateDir(t), dispatchTestScope)
	if err != nil {
		t.Fatal(err)
	}
	defer closeJournal(t, j)
	cmd := desktopCommand("unbound-finished-command")
	claimDesktop(t, j, cmd)
	result := protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID,
		Status: protocol.StatusUncertain, TurnID: "exact-turn"}
	if err := j.Finish(result); err != nil {
		t.Fatal(err)
	}
	if _, err := j.ReadDispatch(cmd.CommandID, cmd.SessionID, result.TurnID); err == nil || errors.Is(err, ErrNoDispatch) {
		t.Fatalf("finished unbound claim granted inspection or fallback: %v", err)
	}
}

func TestDesktopDispatchCorruptionFailsClosed(t *testing.T) {
	for _, partial := range []bool{false, true} {
		dir := testPrivateDir(t)
		j, err := Open(dir, dispatchTestScope)
		if err != nil {
			t.Fatal(err)
		}
		cmd := desktopCommand("corrupt-command")
		identity := claimDesktop(t, j, cmd)
		if partial {
			identity.OwnerID = "owner-without-connection"
		} else {
			identity.ClientUserMessageID = "bad-uuid"
		}
		err = j.db.Update(func(tx *bolt.Tx) error {
			bucket := tx.Bucket(recordsBucket)
			entry, err := decode([]byte(cmd.CommandID), bucket.Get([]byte(cmd.CommandID)))
			if err != nil {
				return err
			}
			entry.Dispatch = &identity
			data, err := json.Marshal(entry)
			if err != nil {
				return err
			}
			return bucket.Put([]byte(cmd.CommandID), data)
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := j.ReadDispatch(cmd.CommandID, cmd.SessionID, "exact-turn"); err == nil || errors.Is(err, ErrNoDispatch) {
			t.Fatalf("corrupt dispatch granted inspection or fallback: %v", err)
		}
		closeJournal(t, j)
		if reopened, err := Open(dir, dispatchTestScope); err == nil {
			closeJournal(t, reopened)
			t.Fatal("corrupt dispatch identity silently reinitialized")
		}
	}
}
