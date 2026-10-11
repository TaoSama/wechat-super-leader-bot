package journal

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/terminal"
	bolt "go.etcd.io/bbolt"
)

func terminalJournalCommand(t *testing.T) (protocol.ControllerCommandMessage, terminal.DeliveryIdentity) {
	t.Helper()
	identity := terminal.DeliveryIdentity{Endpoint: "/fixture/terminal.sock", PaneID: "w1:p1", TerminalID: "terminal-1", WorkspaceID: "w1", TabID: "tab-1",
		Provider: "terminal/codex", AgentSessionSource: "test", AgentSessionAgent: "codex", AgentSessionKind: "path", AgentSessionValue: "/private/session", Revision: 10, PromptSHA256: strings.Repeat("a", 64)}
	session := struct {
		Source string `json:"source"`
		Agent  string `json:"agent"`
		Kind   string `json:"kind"`
		Value  string `json:"value"`
	}{"test", "codex", "path", "/private/session"}
	encoded, err := json.Marshal([]any{identity.Endpoint, identity.PaneID, identity.TerminalID, identity.WorkspaceID, identity.TabID, identity.Provider, session})
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(encoded)
	identity.SessionID = terminal.SessionPrefix + base64.RawURLEncoding.EncodeToString(digest[:])
	cmd := testCommand("terminal-command", "PRIVATE_PROMPT_MUST_NOT_BE_PERSISTED")
	cmd.SessionID, cmd.SendRoute = identity.SessionID, protocol.RouteTerminalPane
	return cmd, identity
}

func TestTerminalJournalBindProofReplayAndExactAck(t *testing.T) {
	dir := testPrivateDir(t)
	j, err := Open(dir, "scope")
	if err != nil {
		t.Fatal(err)
	}
	cmd, identity := terminalJournalCommand(t)
	entry, created, err := j.Begin(cmd)
	if err != nil || !created || entry.TerminalDelivery == nil || !protocol.ValidInputRequestID(entry.TerminalDelivery.RequestID) {
		t.Fatalf("claim: %+v %v", entry, err)
	}
	identity.RequestID = entry.TerminalDelivery.RequestID
	if err := j.BindTerminal(cmd, identity); err != nil {
		t.Fatal(err)
	}
	if err := j.BindTerminal(cmd, identity); err != nil {
		t.Fatal("identical bind:", err)
	}
	changed := identity
	changed.Revision++
	if err := j.BindTerminal(cmd, changed); err == nil {
		t.Fatal("bound identity replaced")
	}
	changed = identity
	changed.PromptSHA256 = strings.Repeat("b", 64)
	if err := j.BindTerminal(cmd, changed); err == nil {
		t.Fatal("bound digest replaced")
	}
	proof := &protocol.InputReceipt{Kind: protocol.TerminalInputWrittenKind, SessionID: identity.SessionID, RequestID: identity.RequestID, PromptSHA256: identity.PromptSHA256, ResponseRevision: 10, ObservedRevision: 11}
	result := protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID, Status: protocol.StatusInputWritten, InputReceipt: proof}
	if err := j.Finish(result); err != nil {
		t.Fatal(err)
	}
	copyProof := *proof
	copyResult := result
	copyResult.InputReceipt = &copyProof
	if err := j.Finish(copyResult); err != nil {
		t.Fatal("value-equal finish:", err)
	}
	if err := j.db.View(func(tx *bolt.Tx) error {
		if strings.Contains(string(tx.Bucket(recordsBucket).Get([]byte(cmd.CommandID))), cmd.Prompt) {
			return fmt.Errorf("prompt persisted")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	closeJournal(t, j)
	j, err = Open(dir, "scope")
	if err != nil {
		t.Fatal(err)
	}
	defer closeJournal(t, j)
	if replay, err := j.Unacked(); err != nil || len(replay) != 1 || !protocol.SameResult(replay[0], result) {
		t.Fatalf("replay: %+v %v", replay, err)
	}
	for _, wrong := range []protocol.ResultAckMessage{
		{CommandID: cmd.CommandID, Status: protocol.StatusInputWritten},
		{CommandID: cmd.CommandID, Status: protocol.StatusCompleted, InputReceipt: proof},
		{CommandID: cmd.CommandID, Status: protocol.StatusInputWritten, InputReceipt: &protocol.InputReceipt{Kind: proof.Kind, SessionID: proof.SessionID, RequestID: proof.RequestID, PromptSHA256: proof.PromptSHA256, ResponseRevision: 10, ObservedRevision: 12}},
	} {
		if err := j.Ack(wrong); err != nil {
			t.Fatal(err)
		}
		if pending, err := j.Unacked(); err != nil || len(pending) != 1 {
			t.Fatal("wrong ACK removed pending")
		}
	}
	if err := j.Ack(protocol.ResultAckMessage{CommandID: cmd.CommandID, Status: result.Status, InputReceipt: proof}); err != nil {
		t.Fatal(err)
	}
	if pending, err := j.Unacked(); err != nil || len(pending) != 0 {
		t.Fatal("exact ACK did not remove pending")
	}
	entry, created, err = j.Begin(cmd)
	if err != nil || created || entry.Result.Status != protocol.StatusInputWritten || !protocol.SameInputReceipt(entry.Result.InputReceipt, proof) {
		t.Fatal("ACK erased replay guard")
	}
	if err := j.BindTerminal(cmd, identity); err == nil {
		t.Fatal("finished preparation rebound")
	}
}

func TestTerminalUnfinishedRecoveryNeverRebinds(t *testing.T) {
	for _, bind := range []bool{false, true} {
		t.Run(fmt.Sprint(bind), func(t *testing.T) {
			dir := testPrivateDir(t)
			j, err := Open(dir, "scope")
			if err != nil {
				t.Fatal(err)
			}
			cmd, identity := terminalJournalCommand(t)
			entry, _, err := j.Begin(cmd)
			if err != nil {
				t.Fatal(err)
			}
			identity.RequestID = entry.TerminalDelivery.RequestID
			if bind {
				if err := j.BindTerminal(cmd, identity); err != nil {
					t.Fatal(err)
				}
			}
			closeJournal(t, j)
			j, err = Open(dir, "scope")
			if err != nil {
				t.Fatal(err)
			}
			defer closeJournal(t, j)
			entry, created, err := j.Begin(cmd)
			if err != nil || created || !entry.Finished || entry.Result.Status != protocol.StatusUncertain || entry.TerminalDelivery.RequestID != identity.RequestID {
				t.Fatalf("recovery: %+v %v", entry, err)
			}
			if err := j.BindTerminal(cmd, identity); err == nil {
				t.Fatal("recovered claim rebound")
			}
		})
	}
}

func TestTerminalJournalRejectsNativeStatusesAndUnboundProof(t *testing.T) {
	j, err := Open(testPrivateDir(t), "scope")
	if err != nil {
		t.Fatal(err)
	}
	defer closeJournal(t, j)
	cmd, identity := terminalJournalCommand(t)
	entry, _, err := j.Begin(cmd)
	if err != nil {
		t.Fatal(err)
	}
	identity.RequestID = entry.TerminalDelivery.RequestID
	for _, status := range []protocol.DaemonResultStatus{protocol.StatusAccepted, protocol.StatusCompleted, protocol.StatusInputWritten} {
		result := protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID, Status: status, TurnID: "native-turn"}
		if err := j.Finish(result); err == nil {
			t.Fatal("terminal accepted native or unbound result")
		}
	}
	if err := j.BindTerminal(cmd, identity); err != nil {
		t.Fatal(err)
	}
	if err := j.Finish(protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID, Status: protocol.StatusFailed}); err != nil {
		t.Fatal(err)
	}
}
