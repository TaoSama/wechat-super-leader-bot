package codex

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
)

const desktopControlNodeLimit = desktopHistoryNodeLimit
const desktopControlDepthLimit = desktopHistoryDepthLimit

var errDesktopControlStateLimit = errors.New("desktop control snapshot exceeds structural limits")
var errDesktopControlStateJSON = errors.New("invalid desktop control snapshot JSON")

// Validate the whole state before allocating turns or arbitrary item trees.
// Unknown fields count too; skipping them must not bypass the resource budget.
func validateDesktopControlState(raw []byte) error {
	if len(raw) > desktopInboundFrameLimit {
		return errDesktopControlStateLimit
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber() // Structure validation must not impose float64 semantics.
	count := 0
	if err := scanDesktopControlValue(decoder, 0, &count); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return errDesktopControlStateJSON
	}
	return nil
}

// Count values/containers with root depth zero, as in the history tree budget.
// Keys and closing delimiters are not nodes. At most three tokens per node are
// consumed, so work remains bounded without materializing an arbitrary tree.
func scanDesktopControlValue(decoder *json.Decoder, depth int, count *int) error {
	if depth > desktopControlDepthLimit || *count >= desktopControlNodeLimit {
		return errDesktopControlStateLimit
	}
	token, err := decoder.Token()
	if err != nil {
		return errDesktopControlStateJSON
	}
	*count++
	delimiter, container := token.(json.Delim)
	if !container {
		return nil
	}
	if delimiter != '{' && delimiter != '[' {
		return errDesktopControlStateJSON
	}
	for decoder.More() {
		if delimiter == '{' {
			key, err := decoder.Token()
			if err != nil {
				return errDesktopControlStateJSON
			}
			if _, valid := key.(string); !valid {
				return errDesktopControlStateJSON
			}
		}
		if err := scanDesktopControlValue(decoder, depth+1, count); err != nil {
			return err
		}
	}
	closing, err := decoder.Token()
	if err != nil || delimiter == '{' && closing != json.Delim('}') || delimiter == '[' && closing != json.Delim(']') {
		return errDesktopControlStateJSON
	}
	return nil
}

func decodeDesktopControlState(raw []byte) (*desktopControlState, error) {
	if err := validateDesktopControlState(raw); err != nil {
		return nil, err
	}
	var state *desktopControlState
	if err := json.Unmarshal(raw, &state); err != nil || state == nil {
		return nil, errDesktopControlStateJSON
	}
	return state, nil
}
