package protocol

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func inputProof() InputReceipt {
	return InputReceipt{Kind: TerminalInputWrittenKind, SessionID: "terminal:" + strings.Repeat("a", 43),
		RequestID: "017de777-b296-42cb-a229-d3d7af3038e5", PromptSHA256: strings.Repeat("b", 64), ResponseRevision: 0, ObservedRevision: 1}
}

func TestInputReceiptStrictWireAndAck(t *testing.T) {
	proof := inputProof()
	data, err := json.Marshal(proof)
	if err != nil {
		t.Fatal(err)
	}
	var decoded InputReceipt
	if err := json.Unmarshal(data, &decoded); err != nil || decoded != proof {
		t.Fatalf("roundtrip: %v %+v", err, decoded)
	}
	bad := []string{
		strings.Replace(string(data), `"responseRevision":0`, `"responseRevision":null`, 1),
		strings.Replace(string(data), `"responseRevision":0,`, "", 1),
		strings.Replace(string(data), `"responseRevision":0`, `"responseRevision":-1`, 1),
		strings.Replace(string(data), `"responseRevision":0`, `"responseRevision":0.5`, 1),
		strings.Replace(string(data), `"observedRevision":1`, `"observedRevision":9007199254740992`, 1),
		strings.Replace(string(data), `"observedRevision":1`, `"observedRevision":0,"observedRevision":1`, 1),
		strings.Replace(string(data), `"kind":`, `"Kind":`, 1),
		string(data[:len(data)-1]) + `,"completed":true}`,
		string(data) + `{}`,
	}
	for _, body := range bad {
		if err := json.Unmarshal([]byte(body), &decoded); err == nil {
			t.Fatalf("invalid proof accepted: %s", body)
		}
	}
	result := DaemonResultMessage{Type: "result", CommandID: "command", Status: StatusInputWritten, InputReceipt: &proof}
	ack := ResultAckMessage{Type: "result_ack", CommandID: "command", Status: StatusInputWritten, InputReceipt: &decoded}
	decoded = proof
	if !ReceiptMatchesAck(result, ack) {
		t.Fatal("exact proof rejected")
	}
	ack.CommandID = "other-command"
	if ReceiptMatchesAck(result, ack) {
		t.Fatal("other command acknowledged")
	}
	ack.CommandID = result.CommandID
	decoded.ObservedRevision++
	if ReceiptMatchesAck(result, ack) {
		t.Fatal("different proof acknowledged")
	}
	ack.InputReceipt = nil
	if ReceiptMatchesAck(result, ack) {
		t.Fatal("missing proof acknowledged")
	}
	ack.InputReceipt = &proof
	ack.TurnID = "invented-turn"
	if ReceiptMatchesAck(result, ack) {
		t.Fatal("native turn attached to input ACK")
	}
	result.Status, ack.Status, ack.TurnID = StatusCompleted, StatusCompleted, ""
	if ReceiptMatchesAck(result, ack) {
		t.Fatal("input proof upgraded to completion")
	}
}

func TestTerminalRouteCannotTargetNativeOrRead(t *testing.T) {
	cmd := ControllerCommandMessage{Type: "command", CommandID: "command", NodeID: "node", SessionID: "native", Action: ActionSend, Prompt: "prompt", ExpiresAt: "2999-01-01T00:00:00Z", SendRoute: RouteTerminalPane}
	if err := cmd.Validate("node", time.Now()); err == nil {
		t.Fatal("native target accepted terminal route")
	}
	cmd.SessionID = inputProof().SessionID
	if err := cmd.Validate("node", time.Now()); err != nil {
		t.Fatal(err)
	}
	cmd.Action = ActionRead
	if err := cmd.Validate("node", time.Now()); err == nil {
		t.Fatal("read accepted send route")
	}
}
