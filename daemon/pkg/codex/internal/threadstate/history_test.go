package threadstate

import "testing"

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
