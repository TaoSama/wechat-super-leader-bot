package transcript

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const maxJSONDepth = 32

type object map[string]json.RawMessage

func field(raw json.RawMessage) object {
	var value object
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	return value
}
func stringField(obj object, key string) string {
	var value string
	if json.Unmarshal(obj[key], &value) != nil {
		return ""
	}
	return value
}

func optionalString(obj object, key string) (string, error) {
	raw, present := obj[key]
	if !present {
		return "", nil
	}
	trimmed := bytes.TrimSpace(raw)
	var value string
	if len(trimmed) == 0 || trimmed[0] != '"' || json.Unmarshal(raw, &value) != nil {
		return "", failure(protocol.HistoryIncomplete)
	}
	return value, nil
}

// Validate before decoding: duplicate identity keys, excessive nesting and
// Unicode replacement during decoding must not silently select a new identity.
func validateJSON(ctx context.Context, data []byte) error {
	if !utf8.Valid(data) {
		return failure(protocol.HistoryIncomplete)
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	var value func(int) error
	value = func(depth int) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if depth > maxJSONDepth {
			return failure(protocol.HistoryIncomplete)
		}
		token, err := d.Token()
		if err != nil {
			return failure(protocol.HistoryIncomplete)
		}
		if text, ok := token.(string); ok && strings.ContainsRune(text, '\ufffd') {
			return failure(protocol.HistoryIncomplete)
		}
		delim, composite := token.(json.Delim)
		if !composite {
			return nil
		}
		if delim == '{' {
			keys := map[string]bool{}
			for d.More() {
				keyToken, err := d.Token()
				if err != nil {
					return failure(protocol.HistoryIncomplete)
				}
				key, ok := keyToken.(string)
				if !ok || keys[key] || strings.ContainsRune(key, '\ufffd') {
					return failure(protocol.HistoryIncomplete)
				}
				keys[key] = true
				if err := value(depth + 1); err != nil {
					return err
				}
			}
		} else if delim == '[' {
			for d.More() {
				if err := value(depth + 1); err != nil {
					return err
				}
			}
		} else {
			return failure(protocol.HistoryIncomplete)
		}
		_, err = d.Token()
		if err != nil {
			return failure(protocol.HistoryIncomplete)
		}
		return nil
	}
	if err := value(0); err != nil {
		return err
	}
	if _, err := d.Token(); !errors.Is(err, io.EOF) {
		return failure(protocol.HistoryIncomplete)
	}
	return nil
}

func parseRecord(ctx context.Context, data []byte, ref Ref, first bool) (item protocol.HistoryItem, recognized bool, err error) {
	if err := validateJSON(ctx, data); err != nil {
		return item, false, err
	}
	obj := field(data)
	if obj == nil {
		return item, false, failure(protocol.HistoryIncomplete)
	}
	item.Type = "transcript_message"
	item.Timestamp = safeTimestamp(stringField(obj, "timestamp"))
	switch ref.Agent {
	case "codex":
		typ := stringField(obj, "type")
		payload := field(obj["payload"])
		if first && typ != "session_meta" {
			return item, false, failure(protocol.HistoryUnavailable)
		}
		if typ == "session_meta" {
			source, sourceErr := optionalString(payload, "source")
			if sourceErr != nil {
				return item, false, sourceErr
			}
			if stringField(payload, "id") != ref.Value || (source != "" && source != "cli") {
				return item, false, failure(protocol.HistoryUnavailable)
			}
			return item, true, nil
		}
		if typ != "response_item" || stringField(payload, "type") != "message" {
			return item, false, nil
		}
		role := stringField(payload, "role")
		phase, phaseErr := optionalString(payload, "phase")
		if phaseErr != nil {
			return item, false, phaseErr
		}
		if (role != "user" && role != "assistant") || (phase != "" && phase != "commentary" && phase != "final") {
			return item, true, nil
		}
		item.Kind = role
		item.Text, err = blockText(payload["content"], "input_text", "output_text")
	case "claude":
		typ := stringField(obj, "type")
		session, sessionErr := optionalString(obj, "sessionId")
		if sessionErr != nil {
			return item, false, sessionErr
		}
		if session != "" && session != ref.Value {
			return item, false, failure(protocol.HistoryUnavailable)
		}
		if typ != "user" && typ != "assistant" {
			return item, false, nil
		}
		if stringField(obj, "sessionId") != ref.Value {
			return item, false, failure(protocol.HistoryUnavailable)
		}
		var sidechain bool
		if raw := obj["isSidechain"]; raw != nil {
			trimmed := bytes.TrimSpace(raw)
			if !bytes.Equal(trimmed, []byte("true")) && !bytes.Equal(trimmed, []byte("false")) || json.Unmarshal(raw, &sidechain) != nil {
				return item, false, failure(protocol.HistoryIncomplete)
			}
		}
		if sidechain {
			return item, true, nil
		}
		message := field(obj["message"])
		if stringField(message, "role") != typ {
			return item, false, failure(protocol.HistoryIncomplete)
		}
		item.Kind = typ
		if bytes.Equal(bytes.TrimSpace(message["content"]), []byte("null")) {
			return item, false, failure(protocol.HistoryIncomplete)
		}
		if json.Unmarshal(message["content"], &item.Text) != nil {
			item.Text, err = blockText(message["content"], "text")
		}
	case "grok":
		if stringField(obj, "method") != "session/update" {
			return item, false, nil
		}
		params := field(obj["params"])
		if params == nil {
			return item, false, failure(protocol.HistoryIncomplete)
		}
		session, sessionErr := optionalString(params, "sessionId")
		if sessionErr != nil {
			return item, false, sessionErr
		}
		if session != "" && session != ref.Value {
			return item, false, failure(protocol.HistoryUnavailable)
		}
		update := field(params["update"])
		typ := stringField(update, "sessionUpdate")
		if update == nil || typ == "" {
			return item, false, failure(protocol.HistoryIncomplete)
		}
		if typ != "user_message_chunk" && typ != "agent_message_chunk" {
			return item, typ == "agent_thought_chunk" || typ == "tool_call" || typ == "tool_call_update", nil
		}
		if session != ref.Value {
			return item, false, failure(protocol.HistoryUnavailable)
		}
		content := field(update["content"])
		if stringField(content, "type") != "text" {
			return item, true, nil
		}
		item.Kind = "user"
		if typ == "agent_message_chunk" {
			item.Kind = "assistant"
		}
		item.Type = "transcript_chunk"
		item.Text, err = optionalString(content, "text")
		if content["text"] == nil {
			return item, false, failure(protocol.HistoryIncomplete)
		}
	}
	if err != nil {
		return item, false, err
	}
	if strings.IndexFunc(item.Text, func(r rune) bool { return unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' }) >= 0 {
		return item, false, failure(protocol.HistoryIncomplete)
	}
	item.Text, item.Truncated = clipText(item.Text)
	return item, true, nil
}

func blockText(raw json.RawMessage, allowed ...string) (string, error) {
	var blocks []json.RawMessage
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &blocks) != nil {
		return "", failure(protocol.HistoryIncomplete)
	}
	var parts []string
	for _, raw := range blocks {
		block := field(raw)
		if block == nil {
			return "", failure(protocol.HistoryIncomplete)
		}
		for _, typ := range allowed {
			if stringField(block, "type") == typ {
				text, err := optionalString(block, "text")
				if err != nil || block["text"] == nil {
					return "", failure(protocol.HistoryIncomplete)
				}
				if text != "" {
					parts = append(parts, text)
				}
				break
			}
		}
	}
	return strings.Join(parts, "\n"), nil
}

func safeTimestamp(text string) string {
	// Timestamps are optional public metadata, not a channel for opaque values.
	if len(text) > 64 || strings.IndexFunc(text, func(r rune) bool { return !(r >= '0' && r <= '9') && !strings.ContainsRune("-:TZ+. ", r) }) >= 0 {
		return ""
	}
	return text
}

func clipText(text string) (string, bool) {
	bytes, units := 0, 0
	for _, r := range text {
		width := utf8.RuneLen(r)
		u := 1
		if r > 0xffff {
			u = 2
		}
		if bytes+width > MaxTextBytes || units+u > protocol.MaxHistoryTextLength {
			return text[:bytes], true
		}
		bytes += width
		units += u
	}
	return text, false
}
