package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
)

// HasOutput reports recorded data, independently of acceptance/completion status.
func (r DaemonResultMessage) HasOutput() bool {
	return r.OutputPresent || r.Output != ""
}

// Completed status alone cannot prove a missing historical output was empty.
func (r DaemonResultMessage) MarshalJSON() ([]byte, error) {
	type fields DaemonResultMessage
	var output *string
	if r.HasOutput() {
		output = &r.Output
	}
	return json.Marshal(struct {
		fields
		Output *string `json:"output,omitempty"`
	}{fields: fields(r), Output: output})
}

func (r *DaemonResultMessage) UnmarshalJSON(data []byte) error {
	type fields DaemonResultMessage
	var wire struct {
		fields
		Output json.RawMessage `json:"output"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	if wire.Output != nil {
		if bytes.Equal(bytes.TrimSpace(wire.Output), []byte("null")) {
			return errors.New("result output must be a string when present")
		}
		if err := json.Unmarshal(wire.Output, &wire.fields.Output); err != nil {
			return err
		}
		// Non-empty text already carries its own presence proof. Keep the flag
		// canonical so string-based results retain equality after journal replay.
		wire.fields.OutputPresent = wire.fields.Output == ""
	}
	*r = DaemonResultMessage(wire.fields)
	return nil
}
