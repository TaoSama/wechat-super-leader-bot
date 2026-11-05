package protocol

import (
	"testing"
	"time"
)

func TestClaudeResumeRouteValidation(t *testing.T) {
	now := time.Now().UTC()
	claudeID := ClaudeSessionPrefix + "11111111-2222-4333-8444-555555555555"
	base := ControllerCommandMessage{Type: "command", CommandID: "command", NodeID: "node", SessionID: claudeID, Action: ActionSend,
		Prompt: "prompt", ExpiresAt: now.Add(time.Minute).Format(time.RFC3339Nano), SendRoute: RouteClaudeResume}
	for _, tc := range []struct {
		name  string
		edit  func(*ControllerCommandMessage)
		valid bool
	}{
		{"next-turn", func(*ControllerCommandMessage) {}, true},
		{"read-without-route", func(c *ControllerCommandMessage) { c.Action, c.Prompt, c.SendRoute = ActionRead, "", "" }, true},
		{"steer", func(c *ControllerCommandMessage) { c.DeliveryMode, c.ExpectedTurnID = DeliverySteer, "turn" }, false},
		{"codex-route", func(c *ControllerCommandMessage) { c.SendRoute = RouteAppServerResume }, false},
		{"no-route", func(c *ControllerCommandMessage) { c.SendRoute = "" }, false},
		{"codex-target", func(c *ControllerCommandMessage) { c.SessionID = "thread" }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cmd := base
			tc.edit(&cmd)
			if err := cmd.Validate("node", now); (err == nil) != tc.valid {
				t.Fatalf("validation=%v valid=%v", err, tc.valid)
			}
		})
	}
}
