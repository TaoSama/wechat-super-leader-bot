package protocol

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	// MaxCommandAttachments bounds the attachments frozen on one send command.
	MaxCommandAttachments = 3
	// MaxAttachmentImageBytes and MaxAttachmentFileBytes mirror the Controller's inbound caps.
	MaxAttachmentImageBytes = 10 * 1024 * 1024
	MaxAttachmentFileBytes  = 20 * 1024 * 1024
	maxAttachmentNameRunes  = 255
	maxAttachmentMimeBytes  = 128
	AttachmentKindImage     = "image"
	AttachmentKindFile      = "file"
)

var (
	attachmentIDPattern   = regexp.MustCompile(`^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$`)
	attachmentHashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
	attachmentMimePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$`)
	imageAttachmentMimes  = map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true}
)

// CommandAttachment describes one inbound chat attachment frozen on a send
// command. The bytes are fetched from the Controller and verified by SHA-256.
type CommandAttachment struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Name   string `json:"name"`
	Mime   string `json:"mime"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

func (a CommandAttachment) validate() error {
	invalid := errors.New("invalid command attachment")
	if !attachmentIDPattern.MatchString(a.ID) || !attachmentHashPattern.MatchString(a.SHA256) ||
		len(a.Mime) > maxAttachmentMimeBytes || !attachmentMimePattern.MatchString(a.Mime) || a.Size <= 0 {
		return invalid
	}
	if !utf8.ValidString(a.Name) || a.Name == "" || utf8.RuneCountInString(a.Name) > maxAttachmentNameRunes ||
		a.Name == "." || a.Name == ".." || strings.ContainsAny(a.Name, "/\\\x00") {
		return invalid
	}
	for _, r := range a.Name {
		if r < 0x20 || r == 0x7f {
			return invalid
		}
	}
	switch a.Kind {
	case AttachmentKindImage:
		if a.Size > MaxAttachmentImageBytes || !imageAttachmentMimes[a.Mime] {
			return invalid
		}
	case AttachmentKindFile:
		if a.Size > MaxAttachmentFileBytes {
			return invalid
		}
	default:
		return invalid
	}
	return nil
}

func (c *ControllerCommandMessage) validateAttachments() error {
	if len(c.Attachments) == 0 {
		return nil
	}
	if c.Action != ActionSend || len(c.Attachments) > MaxCommandAttachments {
		return fmt.Errorf("only send accepts up to %d attachments", MaxCommandAttachments)
	}
	if strings.HasPrefix(c.SessionID, "terminal:") || c.SendRoute == RouteTerminalPane {
		return errors.New("terminal sessions do not accept attachments")
	}
	seen := make(map[string]bool, len(c.Attachments))
	for _, attachment := range c.Attachments {
		if err := attachment.validate(); err != nil {
			return err
		}
		if seen[attachment.ID] {
			return errors.New("duplicate command attachment")
		}
		seen[attachment.ID] = true
	}
	return nil
}
