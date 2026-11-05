package desktop

import (
	"encoding/json"
	"strings"
)

const desktopJSONPatchPathLimit = 64 * 1024

// A patch value may precede both path and op. These fixed alternatives scan the
// value once and retain independent, bounded projections. Unrelated alternatives
// may overflow without invalidating the alternative selected by the final path.
var desktopJSONPatchAlternatives = [...]desktopJSONSchema{
	desktopJSONState, desktopJSONStatus, desktopJSONSoftAtom,
	desktopJSONCollaboration, desktopJSONSettings, desktopJSONTurn,
	desktopJSONTurns, desktopJSONCanonical, desktopJSONHistory,
	desktopJSONEntities, desktopJSONIsland, desktopJSONIslands,
	desktopJSONEntry, desktopJSONEntries,
}

func (p *desktopJSONProjector) patch(output *desktopJSONOutput, depth int) error {
	var op, path *desktopJSONOutput
	var alternatives []desktopJSONTarget
	hasValue := false
	invalidAlias := false
	err := p.fields(func(key string) error {
		switch key {
		case "op":
			op = &desktopJSONOutput{limit: desktopJSONScalarLimit}
			return p.value([]desktopJSONTarget{{desktopJSONAtom, op}}, depth+1)
		case "path":
			path = &desktopJSONOutput{limit: desktopJSONPatchPathLimit}
			return p.value([]desktopJSONTarget{{desktopJSONPath, path}}, depth+1)
		case "value":
			hasValue = true
			alternatives = make([]desktopJSONTarget, len(desktopJSONPatchAlternatives))
			for index, schema := range desktopJSONPatchAlternatives {
				limit := desktopObservedTurnMetadataLimit
				if schema == desktopJSONState {
					limit = desktopJSONProjectionLimit
				}
				alternatives[index] = desktopJSONTarget{schema, &desktopJSONOutput{limit: limit}}
			}
			return p.value(alternatives, depth+1)
		default:
			for _, name := range []string{"op", "path", "value"} {
				if strings.EqualFold(key, name) {
					invalidAlias = true
				}
			}
			return p.value(nil, depth+1)
		}
	})
	if err != nil {
		return err
	}
	if invalidAlias {
		return errDesktopSubscriptionJSON
	}
	if op != nil && op.failed || path != nil && path.failed {
		return errDesktopSubscriptionJSONBounds
	}
	output.text("{")
	comma := false
	put := func(key string, raw []byte) {
		if comma {
			output.text(",")
		}
		comma = true
		output.text("\"" + key + "\":")
		output.put(raw)
	}
	if op != nil {
		put("op", op.raw)
	}
	if path != nil {
		put("path", path.raw)
	}
	if hasValue {
		value := []byte("null")
		var decodedPath []any
		if path != nil && json.Unmarshal(path.raw, &decodedPath) == nil && decodedPath != nil {
			selected := desktopJSONPatchSchema(decodedPath)
			for _, alternative := range alternatives {
				if alternative.schema != selected {
					continue
				}
				if alternative.output.invalid {
					return errDesktopSubscriptionJSON
				}
				if alternative.output.failed {
					if selected == desktopJSONState {
						return errDesktopSubscriptionJSONBounds
					}
					value = []byte("false")
				} else {
					value = alternative.output.raw
				}
				break
			}
		}
		put("value", value)
	}
	output.text("}")
	return nil
}
