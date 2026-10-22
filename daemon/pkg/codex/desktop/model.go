package desktop

import (
	"bytes"
	"encoding/json"
	"strings"
	"unicode"
	"unicode/utf8"
)

const maxDesktopModelMetadataBytes = 256

// Keep the existing identity/status decoder unchanged. Only model metadata uses
// exact JSON keys: struct decoding otherwise folds unknown casing into a match.
// The temporary raw map is discarded; only bounded scalar metadata is retained.
func (s *desktopRuntimeState) UnmarshalJSON(raw []byte) error {
	type runtimeStatus desktopRuntimeState
	var decoded runtimeStatus
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return err
	}
	decoded.LatestModel = fields["latestModel"]
	decoded.LatestReasoningEffort = fields["latestReasoningEffort"]
	decoded.ModelProvider = fields["modelProvider"]
	decoded.LatestCollaborationMode = fields["latestCollaborationMode"]
	if metadata, err := desktopTurnMetadataSnapshot(fields); err == nil {
		decoded.TurnMetadata = metadata
	} else {
		// Unknown history shapes revoke only exact-turn proof, not the scalar
		// runtime observation that this subscription independently established.
		decoded.TurnMetadata = nil
	}
	*s = desktopRuntimeState(decoded)
	return nil
}

// Model names are identities: invalid values are omitted, never clipped into a
// different name. JSON decoding replaces invalid Unicode with U+FFFD.
func desktopModelString(raw json.RawMessage) string {
	var value string
	if json.Unmarshal(raw, &value) != nil || value == "" || len(value) > maxDesktopModelMetadataBytes ||
		strings.TrimSpace(value) != value || strings.Trim(value, "\uFEFF") != value || !utf8.ValidString(value) {
		return ""
	}
	for _, character := range value {
		if unicode.IsControl(character) || character == utf8.RuneError {
			return ""
		}
	}
	return value
}

func desktopNullish(raw json.RawMessage) bool {
	return len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// The boolean preserves nullish versus invalid. Invalid overrides or parents
// must not authorize a fallback to the otherwise valid latestModel.
func desktopModelOverride(raw json.RawMessage) (string, bool) {
	if desktopNullish(raw) {
		return "", true
	}
	return desktopModelString(raw), false
}

func desktopSettingsModel(raw json.RawMessage) (string, bool) {
	if desktopNullish(raw) {
		return "", true
	}
	var settings map[string]json.RawMessage
	if json.Unmarshal(raw, &settings) != nil {
		return "", false
	}
	return desktopModelOverride(settings["model"])
}

func desktopCollaborationModel(raw json.RawMessage) (string, bool) {
	if desktopNullish(raw) {
		return "", true
	}
	var mode map[string]json.RawMessage
	if json.Unmarshal(raw, &mode) != nil {
		return "", false
	}
	return desktopSettingsModel(mode["settings"])
}

func (p *desktopProjection) modelMetadata() (string, string, string) {
	model := p.collaborationModel
	if p.collaborationNullish {
		model = p.latestModel
	}
	if model == "" {
		return "", "", ""
	}
	return model, p.modelProvider, p.reasoningEffort
}

// Retain only bounded scalar fields, not collaboration instructions or history.
// Parent patches rebuild the selected subtree; deletion is explicitly nullish.
func (p *desktopProjection) patchModel(patch desktopPatch, key string) bool {
	raw := patch.Value
	if patch.Op == "remove" {
		raw = nil
	}
	switch key {
	case "latestModel", "latestReasoningEffort", "modelProvider":
		value := ""
		if len(patch.Path) == 1 {
			value = desktopModelString(raw)
		}
		switch key {
		case "latestModel":
			p.latestModel = value
		case "latestReasoningEffort":
			p.reasoningEffort = value
		case "modelProvider":
			p.modelProvider = value
		}
		return true
	case "latestCollaborationMode":
		if len(patch.Path) == 1 {
			p.collaborationModel, p.collaborationNullish = desktopCollaborationModel(raw)
		} else if _, objectKey := patch.Path[1].(string); !objectKey {
			p.collaborationModel, p.collaborationNullish = "", false
		} else if patch.Path[1] == "settings" {
			if len(patch.Path) == 2 {
				p.collaborationModel, p.collaborationNullish = desktopSettingsModel(raw)
			} else if _, objectKey := patch.Path[2].(string); !objectKey {
				p.collaborationModel, p.collaborationNullish = "", false
			} else if patch.Path[2] == "model" {
				p.collaborationModel, p.collaborationNullish = "", false
				if len(patch.Path) == 3 {
					p.collaborationModel, p.collaborationNullish = desktopModelOverride(raw)
				}
			}
		}
		return true
	default:
		return false
	}
}
