package automation

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func fixtureCompletionError(turn, raw string) string {
	return fixtureRecord("event_msg", map[string]any{"type": "task_complete", "turn_id": turn,
		"last_agent_message": nil, "error": json.RawMessage(raw)})
}

func TestTaskCompleteStructuredErrorFixture(t *testing.T) {
	data, err := os.ReadFile("testdata/task-complete-error.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	evidence := inspectFixture(t, string(data), true)
	if evidence.Status != "failed" || evidence.TurnID != "scheduled-turn" || evidence.Text != "" {
		t.Fatalf("scheduled failure replaced by unknown or manual completion: %+v", evidence)
	}
	if strings.Contains(evidence.Reason, "example.invalid") || strings.Contains(evidence.Reason, "cf-ray") {
		t.Fatalf("raw provider error exposed: %+v", evidence)
	}
}

func TestTaskCompleteErrorSemantics(t *testing.T) {
	for _, test := range []struct{ name, raw, want string }{
		{"null", `null`, "completed"},
		{"message", `{"message":"connection failed"}`, "failed"},
		{"structured", `{"message":"HTTP 530","codex_error_info":{"http_connection_failed":{"http_status_code":530}}}`, "failed"},
		{"new metadata", `{"message":"failed","future_field":{"code":1}}`, "failed"},
		{"empty object", `{}`, "unknown"},
		{"empty message", `{"message":""}`, "unknown"},
		{"blank message", `{"message":" \n\t "}`, "unknown"},
		{"null message", `{"message":null}`, "unknown"},
		{"numeric message", `{"message":530}`, "unknown"},
		{"string", `"HTTP 530"`, "unknown"},
		{"empty string", `""`, "unknown"},
		{"false", `false`, "unknown"},
		{"zero", `0`, "unknown"},
		{"array", `[]`, "unknown"},
	} {
		t.Run(test.name, func(t *testing.T) {
			text := fixtureHeartbeat("run", "target", fixtureTime) + fixtureFinal("run", "partial text") + fixtureCompletionError("run", test.raw)
			evidence := inspectFixture(t, text, true)
			if evidence.Status != test.want || (test.want != "completed" && evidence.Text != "") {
				t.Fatalf("error %s: got %+v; want %s", test.raw, evidence, test.want)
			}
		})
	}
}

func TestTaskCompleteErrorWithoutFinal(t *testing.T) {
	for _, raw := range []string{`null`, `{}`, `""`} {
		evidence := inspectFixture(t, fixtureHeartbeat("run", "target", fixtureTime)+fixtureCompletionError("run", raw), true)
		if evidence.Status != "unknown" || evidence.Text != "" {
			t.Fatalf("empty completion became terminal: %+v", evidence)
		}
	}
}

func TestTaskCompleteErrorsStayWithinExactTurn(t *testing.T) {
	for _, raw := range []string{`{"message":"failed"}`, `{}`, `[]`} {
		text := fixtureHeartbeat("run", "target", fixtureTime)
		text += fixtureCompletionError("other", raw) + fixtureFinal("other", "other result")
		text += fixtureFinal("run", "exact result") + fixtureComplete("run")
		evidence := inspectFixture(t, text, true)
		if evidence.Status != "completed" || evidence.TurnID != "run" || evidence.Text != "exact result" {
			t.Fatalf("other turn error contaminated scheduled result: %+v", evidence)
		}
	}
}

func TestTaskCompleteFailureIsNotClearedByLaterRecords(t *testing.T) {
	text := fixtureHeartbeat("run", "target", fixtureTime) + fixtureCompletionError("run", `{"message":"failed"}`)
	text += fixtureFinal("run", "partial final") + fixtureCompletionError("run", `null`)
	evidence := inspectFixture(t, text, true)
	if evidence.Status != "failed" || evidence.TurnID != "run" || evidence.Text != "" {
		t.Fatalf("later record cleared failure: %+v", evidence)
	}
}

func TestTaskCompleteErrorRequiresTrustedScheduledIdentity(t *testing.T) {
	text := fixtureHeartbeatMessage("run", "target", fixtureTime) + fixtureCompletionError("run", `{"message":"failed"}`)
	if evidence := inspectFixture(t, text, true); evidence.Status != "unknown" {
		t.Fatalf("untrusted heartbeat acquired terminal status: %+v", evidence)
	}
	text = fixtureRecord("event_msg", map[string]any{"type": "task_started", "turn_id": "run",
		"turn_attribution": map[string]string{"turn_trigger": "automation_cron_scheduled"}})
	text += fixtureCompletionError("run", `{"message":"failed"}`)
	if evidence := inspectFixture(t, text, false); evidence.Status != "failed" || evidence.TurnID != "run" {
		t.Fatalf("exact cron failure ignored: %+v", evidence)
	}
}

func TestTaskCompleteErrorOnlyAppliesToCompletionEvents(t *testing.T) {
	for _, test := range []struct{ kind, event string }{
		{"event_msg", "task_started"},
		{"event_msg", "item_completed"},
		{"response_item", "task_complete"},
		{"turn_context", "task_complete"},
	} {
		t.Run(test.kind+"/"+test.event, func(t *testing.T) {
			text := fixtureHeartbeat("run", "target", fixtureTime)
			text += fixtureRecord(test.kind, map[string]any{"type": test.event, "turn_id": "run",
				"error": map[string]string{"message": "not a terminal error"}})
			text += fixtureFinal("run", "exact result") + fixtureComplete("run")
			if evidence := inspectFixture(t, text, true); evidence.Status != "completed" || evidence.Text != "exact result" {
				t.Fatalf("non-completion error changed final outcome: %+v", evidence)
			}
		})
	}
}

func TestTaskCompleteErrorDoesNotResolveAmbiguousScheduledTurns(t *testing.T) {
	text := fixtureHeartbeat("first", "target", fixtureTime) + fixtureCompletionError("first", `{"message":"failed"}`)
	text += fixtureHeartbeat("second", "target", fixtureTime) + fixtureFinal("second", "other result") + fixtureComplete("second")
	if evidence := inspectFixture(t, text, true); evidence.Status != "unknown" || evidence.Text != "" {
		t.Fatalf("terminal error bypassed scheduled identity ambiguity: %+v", evidence)
	}
}

func fixtureContinuationTurn(turn, prompt string) string {
	return fixtureRecord("event_msg", map[string]any{"type": "task_started", "turn_id": turn,
		"turn_attribution": map[string]any{"turn_trigger": nil}}) +
		fixtureRecord("response_item", map[string]any{
			"type": "message", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": prompt}},
			"internal_chat_message_metadata_passthrough": map[string]any{"turn_id": turn, "content_item_kinds": []string{"user.text"}},
		})
}

func TestIsContinuationPrompt(t *testing.T) {
	for _, prompt := range []string{
		"继续", "继续。", "继续！", " 继续 ", "继续执行", "继续完成", "继续下文", "接着", "接着写",
		"continue", "Continue", "CONTINUE", "continue.", "continue!", "go on", "proceed",
		"continue execution", "continue task",
	} {
		if !isContinuationPrompt(prompt) {
			t.Errorf("expected %q to be continuation prompt", prompt)
		}
	}
	for _, prompt := range []string{
		"", "   ", "帮我查天气", "今天天气怎么样", "what is the weather", "restart",
		"<heartbeat>some xml</heartbeat>", "停止", "cancel",
	} {
		if isContinuationPrompt(prompt) {
			t.Errorf("expected %q NOT to be continuation prompt", prompt)
		}
	}
}

func TestHeartbeatContinuationSuccess(t *testing.T) {
	text := fixtureHeartbeat("scheduled", "target", fixtureTime) +
		fixtureCompletionError("scheduled", `{"message":"unexpected status 530"}`) +
		fixtureContinuationTurn("cont", "继续") +
		fixtureFinal("cont", "日报已完成") +
		fixtureComplete("cont")
	evidence := inspectFixture(t, text, true)
	if evidence.Status != "completed" || evidence.TurnID != "cont" || evidence.Text != "日报已完成" {
		t.Fatalf("continuation turn completion not returned: %+v", evidence)
	}
}

func TestHeartbeatMultipleContinuationsSuccess(t *testing.T) {
	text := fixtureHeartbeat("t0", "target", fixtureTime) +
		fixtureCompletionError("t0", `{"message":"status 530"}`) +
		fixtureContinuationTurn("t1", "继续") +
		fixtureCompletionError("t1", `{"message":"status 530"}`) +
		fixtureContinuationTurn("t2", "继续") +
		fixtureCompletionError("t2", `{"message":"status 530"}`) +
		fixtureContinuationTurn("t3", "继续") +
		fixtureFinal("t3", "最终日报成果") +
		fixtureComplete("t3")
	evidence := inspectFixture(t, text, true)
	if evidence.Status != "completed" || evidence.TurnID != "t3" || evidence.Text != "最终日报成果" {
		t.Fatalf("multi-turn continuation completion not returned: %+v", evidence)
	}
}

func TestHeartbeatContinuationStillRunning(t *testing.T) {
	text := fixtureHeartbeat("t0", "target", fixtureTime) +
		fixtureCompletionError("t0", `{"message":"status 530"}`) +
		fixtureContinuationTurn("t1", "继续")
	evidence := inspectFixture(t, text, true)
	if evidence.Status != "running" || evidence.TurnID != "t1" {
		t.Fatalf("running continuation not recognized: %+v", evidence)
	}
}

func TestHeartbeatContinuationFailedWithoutFurtherTurns(t *testing.T) {
	text := fixtureHeartbeat("t0", "target", fixtureTime) +
		fixtureCompletionError("t0", `{"message":"status 530"}`) +
		fixtureContinuationTurn("t1", "继续") +
		fixtureCompletionError("t1", `{"message":"status 530"}`)
	evidence := inspectFixture(t, text, true)
	if evidence.Status != "failed" || evidence.TurnID != "t1" {
		t.Fatalf("failed continuation not recognized: %+v", evidence)
	}
}

func TestHeartbeatUnrelatedManualTurnDoesNotContinue(t *testing.T) {
	text := fixtureHeartbeat("t0", "target", fixtureTime) +
		fixtureCompletionError("t0", `{"message":"status 530"}`) +
		fixtureContinuationTurn("t1", "帮我查一下天气") +
		fixtureFinal("t1", "今天晴天") +
		fixtureComplete("t1")
	evidence := inspectFixture(t, text, true)
	if evidence.Status != "failed" || evidence.TurnID != "t0" || evidence.Text != "" {
		t.Fatalf("unrelated manual turn replaced scheduled failure: %+v", evidence)
	}
}
