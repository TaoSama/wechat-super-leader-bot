package threadstate

import (
	"strings"
	"testing"
)

func TestExtractTurnOutputSelectsTerminalMessage(t *testing.T) {
	message := func(text string, phase any) map[string]any {
		return map[string]any{"type": "agentMessage", "text": text, "phase": phase}
	}
	for _, tc := range []struct {
		name  string
		items []any
		want  string
	}{
		{"final-survives-long-commentary", []any{
			message(strings.Repeat("进度", MaxReadLineLength), "commentary"),
			message("  已完成，结果正确。  ", "final_answer"),
		}, "已完成，结果正确。"},
		{"final-preferred-over-unphased", []any{
			message("最终结果", "final_answer"), message("后续未分类消息", nil),
		}, "最终结果"},
		{"latest-final", []any{
			message("旧结果", "final_answer"), message("修正结果", "final_answer"),
		}, "修正结果"},
		{"unphased-provider", []any{
			map[string]any{"type": "agentMessage", "text": "开始处理"},
			message("最终结果", nil),
		}, "最终结果"},
		{"only-nonterminal-messages", []any{
			message("正在处理", "commentary"), message("阶段结果", "partial_answer"),
		}, ""},
		{"empty-final-does-not-reuse-progress", []any{
			message("开始处理", nil), message(" ", "final_answer"),
		}, ""},
		{"empty-latest-unphased", []any{
			message("开始处理", nil), message("", nil),
		}, ""},
		{"tool-and-reasoning-excluded", []any{
			map[string]any{"type": "reasoning", "text": "private"},
			map[string]any{"type": "commandExecution", "aggregatedOutput": "tool output"},
			message("结果", "final_answer"),
		}, "结果"},
		{"final-truncation-retains-unicode", []any{
			message(strings.Repeat("中", MaxReadLineLength+1), "final_answer"),
		}, strings.Repeat("中", MaxReadLineLength) + "...(truncated)"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ExtractTurnOutput(map[string]any{"items": tc.items})
			if err != nil || got != tc.want {
				t.Fatalf("output = %q, error = %v; want %q", got, err, tc.want)
			}
		})
	}
}

func TestExtractTurnOutputMalformedMessagesRemainUnavailable(t *testing.T) {
	for _, tc := range []struct {
		name string
		item any
	}{
		{"missing-text", map[string]any{"type": "agentMessage", "phase": "commentary"}},
		{"nested-text", map[string]any{"type": "agentMessage", "text": map[string]any{"text": "unsupported"}}},
		{"invalid-phase", map[string]any{"type": "agentMessage", "text": "invalid", "phase": true}},
		{"unknown-phase", map[string]any{"type": "agentMessage", "text": "unknown", "phase": "unexpected"}},
		{"invalid-item", "unsupported"},
		{"missing-type", map[string]any{"text": "untyped"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ExtractTurnOutput(map[string]any{"items": []any{
				map[string]any{"type": "agentMessage", "text": "valid final", "phase": "final_answer"},
				tc.item,
			}})
			if err == nil || got != "" {
				t.Fatalf("malformed output = %q, error = %v", got, err)
			}
		})
	}
}
