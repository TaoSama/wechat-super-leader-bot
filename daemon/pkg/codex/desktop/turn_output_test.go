package desktop

import (
	"context"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/internal/threadstate"
)

func TestExactTurnOutputRequiresRecordedItems(t *testing.T) {
	for _, tc := range []struct {
		name      string
		items     any
		present   bool
		wantError bool
	}{
		{"missing", nil, false, true},
		{"null", nil, true, true},
		{"wrong-container", "unavailable", true, true},
		{"wrong-item", []any{"unavailable"}, true, true},
		{"missing-type", []any{map[string]any{"text": "unavailable"}}, true, true},
		{"missing-text", []any{map[string]any{"type": "agentMessage"}}, true, true},
		{"nonstring-text", []any{map[string]any{"type": "agentMessage", "text": nil}}, true, true},
		{"recorded-empty-items", []any{}, true, false},
		{"recorded-empty-text", []any{map[string]any{"type": "agentMessage", "text": ""}}, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			turn := map[string]any{"id": "target", "status": "completed"}
			if tc.present {
				turn["items"] = tc.items
			}
			// Neither the projection nor the desktop path may turn unavailable data into "".
			if _, err := threadstate.ExtractTurnOutput(turn); (err != nil) != tc.wantError {
				t.Fatalf("output projection error=%v wantError=%t", err, tc.wantError)
			}
			delete(turn, "id")
			turn["turnId"] = "target"
			state := controlState()
			state["turns"] = []any{turn}
			path := desktopFixture(t, func(conn *desktopConn) error {
				if err := controlHandshake(conn); err != nil {
					return err
				}
				return controlSnapshot(conn, state, nil)
			})
			observation, err := NewDesktopController(path).InspectTurn(context.Background(), "session", "target")
			if (err != nil) != tc.wantError || err == nil && (observation.Status != "completed" || observation.Output != "") {
				t.Fatalf("desktop observation=%+v error=%v", observation, err)
			}
		})
	}
}
