package protocol

import (
	"errors"
)

const (
	MaxMediaBytes       = 8 * 1024 * 1024
	MaxMediaChunkBytes  = 192 * 1024
	MaxSessionMedia     = 3
	MaxMediaOrdinal     = 1<<53 - 1 // Original image positions must remain exact in JSON number consumers.
	MediaInvalidRequest = "Invalid media request"
	MediaUnavailable    = "Media unavailable"
	MediaContextExpired = "Media context expired"
	MediaFailed         = "Media request failed"
	MediaBusy           = "Too many media requests"
	MediaTimeout        = "Media request timed out"
)

type ListMediaMessage struct {
	Type         string `json:"type"`
	RequestID    string `json:"requestId"`
	NodeID       string `json:"nodeId"`
	SessionID    string `json:"sessionId"`
	MediaContext string `json:"mediaContext,omitempty"`
	ItemID       string `json:"itemId,omitempty"`
	TurnID       string `json:"turnId,omitempty"`
}

func (m ListMediaMessage) Validate(nodeID string) error {
	if m.Type != "list_media" || m.NodeID != nodeID || !ValidHistoryIdentity(m.RequestID) || !ValidHistoryIdentity(m.SessionID) ||
		(m.MediaContext != "" && !ValidMediaToken(m.MediaContext)) || (m.ItemID != "" && !ValidHistoryIdentity(m.ItemID)) || (m.TurnID != "" && !ValidTurnID(m.TurnID)) {
		return errors.New(MediaInvalidRequest)
	}
	return nil
}

type ReadMediaMessage struct {
	Type         string `json:"type"`
	RequestID    string `json:"requestId"`
	NodeID       string `json:"nodeId"`
	SessionID    string `json:"sessionId"`
	MediaContext string `json:"mediaContext"`
	MediaID      string `json:"mediaId"`
	Offset       int64  `json:"offset"`
	MaxBytes     int    `json:"maxBytes"`
}

func (m ReadMediaMessage) Validate(nodeID string) error {
	if m.Type != "read_media" || m.NodeID != nodeID || !ValidHistoryIdentity(m.RequestID) || !ValidHistoryIdentity(m.SessionID) ||
		!ValidMediaToken(m.MediaContext) || !ValidMediaToken(m.MediaID) || m.Offset < 0 || m.Offset > MaxMediaBytes || m.MaxBytes <= 0 || m.MaxBytes > MaxMediaChunkBytes {
		return errors.New(MediaInvalidRequest)
	}
	return nil
}

// NativeMediaReference stays inside the daemon. Paths are never wire fields.
type NativeMediaReference struct {
	ItemID  string `json:"-"`
	TurnID  string `json:"-"`
	Ordinal int    `json:"-"`
	Path    string `json:"-"`
}

type MediaDescriptor struct {
	MediaID   string `json:"mediaId"`
	ItemID    string `json:"itemId"`
	TurnID    string `json:"turnId"`
	Ordinal   int    `json:"ordinal"` // Original image position before unsupported paths are filtered.
	MIME      string `json:"mime"`
	TotalSize int64  `json:"totalSize"`
	SHA256    string `json:"sha256"`
}

type DaemonMediaListMessage struct {
	Type         string            `json:"type"`
	RequestID    string            `json:"requestId"`
	SessionID    string            `json:"sessionId"`
	MediaContext string            `json:"mediaContext,omitempty"`
	Source       string            `json:"source,omitempty"`
	Media        []MediaDescriptor `json:"media,omitempty"`
	Error        string            `json:"error,omitempty"`
}

type DaemonMediaChunkMessage struct {
	Type         string `json:"type"`
	RequestID    string `json:"requestId"`
	SessionID    string `json:"sessionId"`
	MediaContext string `json:"mediaContext"`
	MediaID      string `json:"mediaId"`
	Offset       int64  `json:"offset"`
	TotalSize    int64  `json:"totalSize"`
	MIME         string `json:"mime"`
	SHA256       string `json:"sha256"`
	Data         []byte `json:"data,omitempty"`
	EOF          bool   `json:"eof"`
	Error        string `json:"error,omitempty"`
}

func ValidMediaToken(value string) bool {
	if len(value) != 36 {
		return false
	}
	for i, ch := range value {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if ch != '-' {
				return false
			}
			continue
		}
		if !(ch >= '0' && ch <= '9' || ch >= 'a' && ch <= 'f') {
			return false
		}
	}
	return true
}
