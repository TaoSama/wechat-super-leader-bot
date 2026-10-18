package protocol

import (
	"testing"
	"time"
)

func TestDeliveryModeValidationAndIdentity(t *testing.T) {
	now := time.Now().UTC()
	base := ControllerCommandMessage{Type: "command", CommandID: "command", NodeID: "node", SessionID: "session", Action: ActionSend, Prompt: "prompt", ExpiresAt: now.Add(time.Minute).Format(time.RFC3339Nano)}
	for _, tc := range []struct {
		name  string
		mode  DeliveryMode
		turn  string
		valid bool
	}{
		{"default", "", "", true},
		{"next", DeliveryNextTurn, "", true},
		{"steer", DeliverySteer, "exact-turn", true},
		{"missing-turn", DeliverySteer, "", false},
		{"invalid-turn", DeliverySteer, "bad turn", false},
		{"next-with-turn", DeliveryNextTurn, "exact-turn", false},
		{"default-with-turn", "", "exact-turn", false},
		{"unknown", "unknown", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cmd := base
			cmd.DeliveryMode, cmd.ExpectedTurnID = tc.mode, tc.turn
			if err := cmd.Validate("node", now); (err == nil) != tc.valid {
				t.Fatalf("validation=%v valid=%v", err, tc.valid)
			}
			if tc.mode != "" || tc.turn != "" {
				if cmd.PayloadFingerprint() == base.PayloadFingerprint() {
					t.Fatal("delivery identity omitted from fingerprint")
				}
			}
		})
	}
	cmd := base
	cmd.DeliveryMode, cmd.ExpectedTurnID = DeliverySteer, "exact-turn"
	first := cmd.PayloadFingerprint()
	cmd.ExpectedTurnID = "other-turn"
	if cmd.PayloadFingerprint() == first {
		t.Fatal("expected turn omitted from fingerprint")
	}
	cmd.SessionID = "terminal:pane"
	if err := cmd.Validate("node", now); err == nil {
		t.Fatal("terminal steering accepted")
	}
}
