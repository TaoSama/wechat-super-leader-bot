package protocol

import (
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/skills"
)

func TestInterruptValidationAndIdentity(t *testing.T) {
	now := time.Now().UTC()
	base := ControllerCommandMessage{Type: "command", CommandID: "command", NodeID: "node", SessionID: "session",
		Action: ActionInterrupt, ExpectedTurnID: "running-turn", ExpiresAt: now.Add(time.Minute).Format(time.RFC3339Nano)}
	for _, tc := range []struct {
		name   string
		change func(*ControllerCommandMessage)
		want   string
	}{
		{"exact", func(*ControllerCommandMessage) {}, ""},
		{"desktop", func(c *ControllerCommandMessage) { c.SendRoute = RouteDesktopOwner }, ""},
		{"control", func(c *ControllerCommandMessage) { c.SendRoute = RouteControlSocket }, ""},
		{"managed", func(c *ControllerCommandMessage) { c.SendRoute = RouteAppServerResume }, ""},
		{"terminal-session", func(c *ControllerCommandMessage) { c.SessionID = "terminal:pane-1" }, TerminalInterruptUnsupported},
		{"terminal-route", func(c *ControllerCommandMessage) { c.SendRoute = RouteTerminalPane }, TerminalInterruptUnsupported},
		{"missing-turn", func(c *ControllerCommandMessage) { c.ExpectedTurnID = "" }, "interrupt requires an exact native expectedTurnId"},
		{"invalid-turn", func(c *ControllerCommandMessage) { c.ExpectedTurnID = "bad turn" }, "interrupt requires an exact native expectedTurnId"},
		{"prompt", func(c *ControllerCommandMessage) { c.Prompt = "stop" }, "interrupt carries no prompt, skills or delivery mode"},
		{"skills", func(c *ControllerCommandMessage) { c.Skills = []skills.Ref{{ID: "skill", Digest: "digest"}} }, "interrupt carries no prompt, skills or delivery mode"},
		{"delivery", func(c *ControllerCommandMessage) { c.DeliveryMode = DeliverySteer }, "interrupt carries no prompt, skills or delivery mode"},
		{"unknown-route", func(c *ControllerCommandMessage) { c.SendRoute = "future" }, "invalid interrupt route"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cmd := base
			tc.change(&cmd)
			err := cmd.Validate("node", now)
			if tc.want == "" && err != nil || tc.want != "" && (err == nil || err.Error() != tc.want) {
				t.Fatalf("validation = %v, want %q", err, tc.want)
			}
		})
	}
	other := base
	other.ExpectedTurnID = "another-turn"
	if other.PayloadFingerprint() == base.PayloadFingerprint() {
		t.Fatal("interrupt target turn omitted from fingerprint")
	}
}

// Existing journal records must keep their exact fingerprints.
func TestSendAndReadFingerprintsUnchanged(t *testing.T) {
	read := ControllerCommandMessage{NodeID: "node", SessionID: "session", Action: ActionRead, ExpiresAt: "2026-01-01T00:00:00Z"}
	send := ControllerCommandMessage{NodeID: "node", SessionID: "session", Action: ActionSend, Prompt: "p", ExpiresAt: "2026-01-01T00:00:00Z", SendRoute: RouteDesktopOwner}
	if got := read.PayloadFingerprint(); got != `["node","session","read","","2026-01-01T00:00:00Z",[]]` {
		t.Fatalf("read fingerprint = %s", got)
	}
	if got := send.PayloadFingerprint(); got != `["node","session","send","p","2026-01-01T00:00:00Z",[],"desktop-owner"]` {
		t.Fatalf("send fingerprint = %s", got)
	}
}

func TestApproveValidationAndIdentity(t *testing.T) {
	now := time.Now().UTC()
	base := ControllerCommandMessage{Type: "command", CommandID: "command", NodeID: "node", SessionID: "session",
		Action: ActionApprove, ExpectedTurnID: "turn", ApprovalRequestID: "7", ApprovalDecision: ApprovalAccept,
		ExpiresAt: now.Add(time.Minute).Format(time.RFC3339Nano)}
	for _, tc := range []struct {
		name   string
		change func(*ControllerCommandMessage)
		ok     bool
	}{
		{"accept", func(*ControllerCommandMessage) {}, true},
		{"decline-desktop", func(c *ControllerCommandMessage) {
			c.ApprovalDecision, c.SendRoute = ApprovalDecline, RouteDesktopOwner
		}, true},
		{"session-wide", func(c *ControllerCommandMessage) { c.ApprovalDecision = "acceptForSession" }, false},
		{"cancel", func(c *ControllerCommandMessage) { c.ApprovalDecision = "cancel" }, false},
		{"missing-request", func(c *ControllerCommandMessage) { c.ApprovalRequestID = "" }, false},
		{"bad-request", func(c *ControllerCommandMessage) { c.ApprovalRequestID = "a b" }, false},
		{"missing-turn", func(c *ControllerCommandMessage) { c.ExpectedTurnID = "" }, false},
		{"terminal", func(c *ControllerCommandMessage) { c.SessionID = "terminal:pane" }, false},
		{"claude", func(c *ControllerCommandMessage) { c.SessionID = ClaudeSessionPrefix + "x" }, false},
		{"prompt", func(c *ControllerCommandMessage) { c.Prompt = "yes" }, false},
		{"fields-on-send", func(c *ControllerCommandMessage) { c.Action, c.Prompt, c.ExpectedTurnID = ActionSend, "p", "" }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cmd := base
			tc.change(&cmd)
			if err := cmd.Validate("node", now); (err == nil) != tc.ok {
				t.Fatalf("validation = %v, want ok=%v", err, tc.ok)
			}
		})
	}
	other := base
	other.ApprovalDecision = ApprovalDecline
	if other.PayloadFingerprint() == base.PayloadFingerprint() {
		t.Fatal("approval decision omitted from fingerprint")
	}
}
