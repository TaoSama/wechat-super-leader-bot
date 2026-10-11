package protocol_test

import (
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/skills"
)

func TestControllerCommandMessage_ValidationAndExpiry(t *testing.T) {
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	future := now.Add(1 * time.Minute).Format(time.RFC3339Nano)
	past := now.Add(-1 * time.Minute).Format(time.RFC3339Nano)

	// Valid read command
	validRead := protocol.ControllerCommandMessage{
		Type:      "command",
		CommandID: "cmd-1",
		NodeID:    "macair",
		SessionID: "sess-1",
		Action:    protocol.ActionRead,
		ExpiresAt: future,
	}
	if err := validRead.Validate("macair", now); err != nil {
		t.Fatalf("expected valid read, got error: %v", err)
	}
	if validRead.IsExpiredAt(now) {
		t.Fatalf("expected not expired")
	}

	// Valid send command
	validSend := protocol.ControllerCommandMessage{
		Type:      "command",
		CommandID: "cmd-2",
		NodeID:    "macair",
		SessionID: "sess-1",
		Action:    protocol.ActionSend,
		Prompt:    "hello world",
		ExpiresAt: future,
	}
	if err := validSend.Validate("macair", now); err != nil {
		t.Fatalf("expected valid send, got error: %v", err)
	}

	// Send without prompt must fail
	invalidSend := validSend
	invalidSend.Prompt = "   "
	if err := invalidSend.Validate("macair", now); err == nil {
		t.Fatalf("expected error for empty prompt in send action")
	}

	// Expired command must fail
	expiredCmd := validRead
	expiredCmd.ExpiresAt = past
	if err := expiredCmd.Validate("macair", now); err == nil {
		t.Fatalf("expected validation error for expired command")
	}
	if !expiredCmd.IsExpiredAt(now) {
		t.Fatalf("expected IsExpiredAt(now) == true")
	}

	// Empty expiresAt must fail closed
	emptyExpCmd := validRead
	emptyExpCmd.ExpiresAt = ""
	if err := emptyExpCmd.Validate("macair", now); err == nil {
		t.Fatalf("expected validation error for empty expiresAt")
	}
	if !emptyExpCmd.IsExpiredAt(now) {
		t.Fatalf("expected empty expiresAt to fail closed as expired")
	}

	// Malformed expiresAt must fail closed
	badExpCmd := validRead
	badExpCmd.ExpiresAt = "not-a-timestamp"
	if err := badExpCmd.Validate("macair", now); err == nil {
		t.Fatalf("expected validation error for bad expiresAt")
	}
	if !badExpCmd.IsExpiredAt(now) {
		t.Fatalf("expected malformed expiresAt to fail closed as expired")
	}

	// NodeID mismatch must fail
	mismatchNode := validRead
	mismatchNode.NodeID = "other-node"
	if err := mismatchNode.Validate("macair", now); err == nil {
		t.Fatalf("expected error for node mismatch")
	}
}

func TestSkillCommandAndFingerprint(t *testing.T) {
	now := time.Now()
	base := protocol.ControllerCommandMessage{Type: "command", CommandID: "test", NodeID: "node", SessionID: "session", Action: protocol.ActionSend,
		Prompt: "task", ExpiresAt: now.Add(time.Minute).Format(time.RFC3339Nano)}
	withSkill := base
	withSkill.Skills = []skills.Ref{{ID: strings.Repeat("a", 64), Digest: strings.Repeat("b", 64)}}
	if err := withSkill.Validate("node", now); err != nil {
		t.Fatal(err)
	}
	if withSkill.PayloadFingerprint() == base.PayloadFingerprint() {
		t.Fatal("skill was omitted from fingerprint")
	}
	withSkill.Skills[0].Digest = "invalid"
	if err := withSkill.Validate("node", now); err == nil {
		t.Fatal("invalid digest accepted")
	}
	// Delimiters in different fields cannot collide.
	a, b := base, base
	a.SessionID, a.Action, a.Prompt = "s|send", protocol.ActionSend, "p"
	b.SessionID, b.Action, b.Prompt = "s", protocol.ActionSend, "send|p"
	if a.PayloadFingerprint() == b.PayloadFingerprint() {
		t.Fatal("delimiter collision")
	}
}
