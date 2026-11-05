package protocol

import (
	"strings"
	"testing"
	"time"
)

func attachmentCommand() ControllerCommandMessage {
	return ControllerCommandMessage{Type: "command", CommandID: "cmd-1", NodeID: "node", SessionID: "session", Action: ActionSend,
		Prompt: "看看这张图", ExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano),
		Attachments: []CommandAttachment{{ID: "6f1c2a8e-1d2b-4c3d-8e9f-0a1b2c3d4e5f", Kind: AttachmentKindImage, Name: "image.png",
			Mime: "image/png", Size: 42, SHA256: strings.Repeat("a", 64)}}}
}

func TestCommandAttachmentsValidateAndBindFingerprint(t *testing.T) {
	cmd := attachmentCommand()
	if err := cmd.Validate("node", time.Now()); err != nil {
		t.Fatalf("valid attachment rejected: %v", err)
	}
	withAttachment := cmd.PayloadFingerprint()
	cmd.Attachments = nil
	if cmd.PayloadFingerprint() == withAttachment {
		t.Fatal("attachments must be part of the payload identity")
	}
}

func TestCommandAttachmentsRejectUnsafeShapes(t *testing.T) {
	cases := map[string]func(*ControllerCommandMessage){
		"path name":       func(c *ControllerCommandMessage) { c.Attachments[0].Name = "../etc/passwd" },
		"control name":    func(c *ControllerCommandMessage) { c.Attachments[0].Name = "a\nb" },
		"oversized image": func(c *ControllerCommandMessage) { c.Attachments[0].Size = MaxAttachmentImageBytes + 1 },
		"image mime":      func(c *ControllerCommandMessage) { c.Attachments[0].Mime = "text/html" },
		"bad hash":        func(c *ControllerCommandMessage) { c.Attachments[0].SHA256 = "abc" },
		"unknown kind":    func(c *ControllerCommandMessage) { c.Attachments[0].Kind = "video" },
		"duplicate":       func(c *ControllerCommandMessage) { c.Attachments = append(c.Attachments, c.Attachments[0]) },
		"read action":     func(c *ControllerCommandMessage) { c.Action, c.Prompt = ActionRead, "" },
		"terminal":        func(c *ControllerCommandMessage) { c.SessionID, c.SendRoute = "terminal:abc", RouteTerminalPane },
		"too many": func(c *ControllerCommandMessage) {
			for i := 0; i < MaxCommandAttachments; i++ {
				next := c.Attachments[0]
				next.ID = strings.Replace(next.ID, "6f1c", "6f1"+string(rune('a'+i)), 1)
				c.Attachments = append(c.Attachments, next)
			}
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			cmd := attachmentCommand()
			mutate(&cmd)
			if err := cmd.Validate("node", time.Now()); err == nil {
				t.Fatal("unsafe attachment accepted")
			}
		})
	}
	file := attachmentCommand()
	file.Attachments[0].Kind, file.Attachments[0].Mime, file.Attachments[0].Size = AttachmentKindFile, "application/pdf", MaxAttachmentFileBytes
	if err := file.Validate("node", time.Now()); err != nil {
		t.Fatalf("file at the size cap rejected: %v", err)
	}
}
