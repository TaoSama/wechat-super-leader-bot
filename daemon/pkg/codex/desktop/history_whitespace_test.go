package desktop

import (
	"context"
	"testing"
)

func TestDesktopHistoryAdapterPreservesBodyWhitespace(t *testing.T) {
	const assistant = "    const answer = 42\n    console.log(answer)\n"
	const first = "first line  "
	const second = "    indented block\n\n"
	const whitespace = " \t\n "
	user := historyTestItem("user", "userMessage", first)
	user["content"] = append(user["content"].([]any),
		map[string]any{"type": "inputText", "text": second},
		map[string]any{"type": "text", "text": whitespace})
	state := historyTestState(true, historyTestTurn("turn", user,
		historyTestItem("assistant", "agentMessage", assistant),
		historyTestItem("blank", "agentMessage", whitespace)))
	path := desktopFixture(t, func(c *desktopConn) error {
		if err := historyFixtureStart(c, state); err != nil {
			return err
		}
		return historyFixtureEnd(c)
	})
	reader := NewDesktopHistoryReader(path)
	t.Cleanup(reader.Reset)
	ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
	defer cancel()
	history, _, err := reader.ReadHistory(ctx, "session", "", "", 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(history.Items) != 3 || history.Truncated {
		t.Fatalf("invalid history page: items=%d truncated=%v", len(history.Items), history.Truncated)
	}
	for i, want := range []string{first + "\n" + second + "\n" + whitespace, assistant, whitespace} {
		if item := history.Items[i]; item.Text != want || item.Truncated {
			t.Errorf("item %s body=%q want=%q truncated=%v", item.ID, item.Text, want, item.Truncated)
		}
	}
}
