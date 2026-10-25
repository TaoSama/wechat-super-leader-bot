package threadstate

import (
	"strings"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestHistoryBodyPreservesWhitespace(t *testing.T) {
	const body = "    const answer = 42\n    console.log(answer)\n\n"
	for _, tc := range []struct {
		name string
		raw  map[string]any
		want string
	}{
		{"assistant indentation", map[string]any{"type": "agentMessage", "text": body}, body},
		{"assistant whitespace only", map[string]any{"type": "agentMessage", "text": " \t\n "}, " \t\n "},
		{"assistant non-string", map[string]any{"type": "agentMessage", "text": false}, ""},
		{"user multiple blocks", map[string]any{"type": "userMessage", "content": []any{
			map[string]any{"type": "text", "text": "first line  "},
			map[string]any{"type": "inputText", "text": body},
			map[string]any{"type": "text", "text": " \t "},
			map[string]any{"type": "image"},
		}}, "first line  \n" + body + "\n \t \n[Image]"},
		{"command output", map[string]any{"type": "commandExecution", "aggregatedOutput": body, "command": " command "}, body},
		{"file diff", map[string]any{"type": "fileChange", "changes": []any{
			map[string]any{"path": " file.go ", "diff": body},
		}}, "file.go\n" + body},
		{"mcp output", map[string]any{"type": "mcpToolCall", "result": map[string]any{"content": []any{
			map[string]any{"type": "text", "text": body},
		}}}, body},
		{"dynamic output", map[string]any{"type": "dynamicToolCall", "contentItems": []any{
			map[string]any{"type": "inputText", "text": body},
		}}, body},
		{"function output", map[string]any{"type": "functionCallOutput", "output": body}, body},
		{"review body", map[string]any{"type": "enteredReviewMode", "review": body}, body},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.raw["id"], tc.raw["status"] = " item ", " completed "
			item, ok := PublicHistoryItem(map[string]any{"turnId": " turn ", "turnStatus": " completed ", "item": tc.raw})
			if !ok || item.Text != tc.want || item.Truncated {
				t.Fatalf("body=%q want=%q included=%v truncated=%v", item.Text, tc.want, ok, item.Truncated)
			}
			if item.ID != "item" || item.TurnID != "turn" || item.Status != "completed" || item.TurnStatus != "completed" {
				t.Fatalf("metadata normalization changed: %+v", item)
			}
			if tc.name == "command output" && item.Title != "command" {
				t.Fatalf("command title=%q", item.Title)
			}
		})
	}
}

func TestHistoryBodyClipsOriginalBytes(t *testing.T) {
	body := strings.Repeat(" ", protocol.MaxHistoryTextLength) + "answer"
	item, ok := PublicHistoryItem(map[string]any{"turnId": "turn", "item": map[string]any{
		"id": "item", "type": "agentMessage", "text": body,
	}})
	if !ok || !item.Truncated || item.Text != body[:protocol.MaxHistoryTextLength] {
		t.Fatalf("original body was not bounded: bytes=%d included=%v truncated=%v", len(item.Text), ok, item.Truncated)
	}
}

func TestHistoryTurnStatusUsesOnlyExactTurnMetadata(t *testing.T) {
	for _, status := range []string{"inProgress", "completed", "failed", "interrupted", "unknown", "", "done"} {
		wrapper := map[string]any{"turnId": "turn", "turnStatus": status,
			"item": map[string]any{"id": "tool", "type": "commandExecution", "status": "completed", "aggregatedOutput": "output"}}
		item, ok := PublicHistoryItem(wrapper)
		if !ok || item.Status != "completed" {
			t.Fatal("native tool projection changed")
		}
		want := status
		if status == "unknown" || status == "done" {
			want = ""
		}
		if item.TurnStatus != want {
			t.Fatalf("turnStatus=%q want=%q", item.TurnStatus, want)
		}
	}
}

func TestHistoryItemDurationIsDerivedAndBounded(t *testing.T) {
	base := map[string]any{
		"turnId":        "turn",
		"startedAtMs":   float64(1_000),
		"completedAtMs": float64(3_250),
		"item":          map[string]any{"id": "tool", "type": "commandExecution", "status": "completed", "aggregatedOutput": "done"},
	}
	item, ok := PublicHistoryItem(base)
	if !ok || item.DurationMs != 2_250 {
		t.Fatalf("duration=%d included=%v want=2250", item.DurationMs, ok)
	}
	for _, tc := range []struct {
		name  string
		start float64
		end   float64
	}{
		{name: "reverse", start: 3_250, end: 1_000},
		{name: "too long", start: 1_000, end: float64(protocol.MaxHistoryDurationMs + 2_000)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			wrapper := map[string]any{
				"turnId": "turn", "startedAtMs": tc.start, "completedAtMs": tc.end,
				"item": map[string]any{"id": "tool", "type": "commandExecution", "status": "completed", "aggregatedOutput": "done"},
			}
			item, ok := PublicHistoryItem(wrapper)
			if !ok || item.DurationMs != 0 {
				t.Fatalf("duration=%d included=%v want omitted", item.DurationMs, ok)
			}
		})
	}
}
