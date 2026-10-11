package protocol

import (
	"encoding/json"
	"testing"
)

func TestResultOutputWirePresence(t *testing.T) {
	for _, tc := range []struct {
		name    string
		result  DaemonResultMessage
		present bool
	}{
		{"missing-completed", DaemonResultMessage{Status: StatusCompleted}, false},
		{"recorded-empty-completed", DaemonResultMessage{Status: StatusCompleted, OutputPresent: true}, true},
		{"recorded-text", DaemonResultMessage{Status: StatusCompleted, Output: "报告😀\n"}, true},
		{"accepted-without-output", DaemonResultMessage{Status: StatusAccepted}, false},
		{"accepted-with-ack-text", DaemonResultMessage{Status: StatusAccepted, Output: "turnId=target"}, true},
		{"uncertain", DaemonResultMessage{Status: StatusUncertain}, false},
		{"failed", DaemonResultMessage{Status: StatusFailed}, false},
		{"terminal-input", DaemonResultMessage{Status: StatusInputWritten}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.result.Type, tc.result.CommandID = "result", "command"
			data, err := json.Marshal(tc.result)
			if err != nil {
				t.Fatal(err)
			}
			var frame map[string]json.RawMessage
			if err := json.Unmarshal(data, &frame); err != nil {
				t.Fatal(err)
			}
			if _, exists := frame["output"]; exists != tc.present {
				t.Fatalf("output presence=%t want=%t: %s", exists, tc.present, data)
			}
			if _, exists := frame["OutputPresent"]; exists {
				t.Fatal("internal presence flag leaked onto wire")
			}
			var decoded DaemonResultMessage
			if err := json.Unmarshal(data, &decoded); err != nil {
				t.Fatal(err)
			}
			if !SameResult(tc.result, decoded) || decoded.HasOutput() != tc.present {
				t.Fatalf("roundtrip changed recorded data: %+v -> %+v", tc.result, decoded)
			}
		})
	}
}

func TestResultMissingAndEmptyDoNotDeduplicateAsSameReceipt(t *testing.T) {
	missing := DaemonResultMessage{Type: "result", CommandID: "command", Status: StatusCompleted}
	empty := missing
	empty.OutputPresent = true
	if SameResult(missing, empty) {
		t.Fatal("missing output treated as a recorded empty output")
	}
}

func TestResultOutputDecoderRejectsNonStringsAndResetsPresence(t *testing.T) {
	for _, output := range []string{"null", "123", "[]", "{}", "true"} {
		var result DaemonResultMessage
		if err := json.Unmarshal([]byte(`{"type":"result","output":`+output+`}`), &result); err == nil {
			t.Fatalf("invalid output accepted: %s", output)
		}
	}
	result := DaemonResultMessage{Output: "stale", OutputPresent: true}
	if err := json.Unmarshal([]byte(`{"type":"result","status":"completed"}`), &result); err != nil {
		t.Fatal(err)
	}
	if result.HasOutput() || result.Output != "" {
		t.Fatalf("missing field retained previous output: %+v", result)
	}
}
