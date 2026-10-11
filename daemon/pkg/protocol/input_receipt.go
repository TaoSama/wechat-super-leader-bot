package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"regexp"
)

const (
	TerminalInputWrittenKind        = "terminal-input-written"
	TerminalNonAtomicMode           = "non-atomic"
	MaxSafeRevision          uint64 = 1<<53 - 1
)

var receiptUUIDPattern = regexp.MustCompile(`^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-4[a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$`)
var receiptDigestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var receiptSessionPattern = regexp.MustCompile(`^terminal:[A-Za-z0-9_-]{43}$`)

func ValidInputRequestID(value string) bool    { return receiptUUIDPattern.MatchString(value) }
func ValidTerminalSessionID(value string) bool { return receiptSessionPattern.MatchString(value) }

// InputReceipt is input-write evidence, never native turn or completion proof.
type InputReceipt struct {
	Kind             string `json:"kind"`
	SessionID        string `json:"sessionId"`
	RequestID        string `json:"requestId"`
	PromptSHA256     string `json:"promptSHA256"`
	ResponseRevision uint64 `json:"responseRevision"`
	ObservedRevision uint64 `json:"observedRevision"`
}

func (r InputReceipt) Validate() error {
	if r.Kind != TerminalInputWrittenKind || !receiptSessionPattern.MatchString(r.SessionID) ||
		!receiptUUIDPattern.MatchString(r.RequestID) || !receiptDigestPattern.MatchString(r.PromptSHA256) ||
		r.ResponseRevision > MaxSafeRevision || r.ObservedRevision > MaxSafeRevision || r.ObservedRevision < r.ResponseRevision {
		return errors.New("invalid terminal input receipt")
	}
	return nil
}

// UnmarshalJSON rejects extra, duplicate, missing and null proof fields rather
// than letting a malformed ACK equal a valid persisted receipt after decoding.
func (r *InputReceipt) UnmarshalJSON(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return errors.New("invalid terminal input receipt")
	}
	fields := make(map[string]json.RawMessage)
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return errors.New("invalid terminal input receipt")
		}
		key, ok := keyToken.(string)
		if !ok || fields[key] != nil {
			return errors.New("invalid terminal input receipt")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return errors.New("invalid terminal input receipt")
		}
		fields[key] = value
	}
	if _, err := decoder.Token(); err != nil {
		return errors.New("invalid terminal input receipt")
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) || len(fields) != 6 {
		return errors.New("invalid terminal input receipt")
	}
	var value InputReceipt
	targets := map[string]any{"kind": &value.Kind, "sessionId": &value.SessionID, "requestId": &value.RequestID,
		"promptSHA256": &value.PromptSHA256, "responseRevision": &value.ResponseRevision, "observedRevision": &value.ObservedRevision}
	for key, target := range targets {
		field, exists := fields[key]
		if !exists || json.Unmarshal(field, target) != nil {
			return errors.New("invalid terminal input receipt")
		}
	}
	if err := value.Validate(); err != nil {
		return err
	}
	*r = value
	return nil
}

func SameInputReceipt(a, b *InputReceipt) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}

func SameResult(a, b DaemonResultMessage) bool {
	return a.Type == b.Type && a.CommandID == b.CommandID && a.Status == b.Status && a.Output == b.Output && a.HasOutput() == b.HasOutput() &&
		a.Error == b.Error && a.TurnID == b.TurnID && SameInputReceipt(a.InputReceipt, b.InputReceipt)
}

func ReceiptMatchesAck(result DaemonResultMessage, ack ResultAckMessage) bool {
	if result.CommandID != ack.CommandID || result.Status != ack.Status || result.TurnID != ack.TurnID {
		return false
	}
	if result.Status == StatusInputWritten {
		return result.TurnID == "" && result.InputReceipt != nil && result.InputReceipt.Validate() == nil &&
			ack.InputReceipt != nil && ack.InputReceipt.Validate() == nil && SameInputReceipt(result.InputReceipt, ack.InputReceipt)
	}
	return result.InputReceipt == nil && ack.InputReceipt == nil
}
