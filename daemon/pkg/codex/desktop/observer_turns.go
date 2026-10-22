package desktop

import (
	"encoding/json"
	"errors"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const desktopObservedTurnMetadataLimit = 1024 * 1024

type desktopObservedTurn struct {
	TurnID string `json:"turnId"`
	Status string `json:"status"`
}

type desktopObservedEntry struct {
	Value string `json:"value"`
}
type desktopObservedIsland struct {
	Entries []desktopObservedEntry `json:"entries"`
}
type desktopObservedHistory struct {
	Islands       []desktopObservedIsland        `json:"islands"`
	EntitiesByKey map[string]desktopObservedTurn `json:"entitiesByKey"`
}
type desktopObservedCanonical struct {
	Kind    string                  `json:"kind"`
	History *desktopObservedHistory `json:"history"`
}

func desktopTurnMetadataSnapshot(fields map[string]json.RawMessage) ([]byte, error) {
	projection := make(map[string]json.RawMessage)
	for _, key := range []string{"turns", "turnHistory"} {
		if raw, exists := fields[key]; exists {
			value, relevant, err := desktopTurnMetadataValue([]any{key}, raw)
			if err != nil || !relevant {
				return nil, errors.New("invalid observed turn metadata")
			}
			projection[key] = value
		}
	}
	encoded, err := json.Marshal(projection)
	if err != nil || len(encoded) > desktopObservedTurnMetadataLimit {
		return nil, errors.New("observed turn metadata exceeds bounds")
	}
	return encoded, nil
}

// Only identities, statuses and canonical membership survive this projection.
// Items, output, instructions and all other fields are discarded before retain.
func desktopTurnMetadataValue(path []any, raw json.RawMessage) (json.RawMessage, bool, error) {
	var target any
	if len(path) == 0 {
		return nil, false, nil
	}
	switch path[0] {
	case "turns":
		switch {
		case len(path) == 1:
			target = new([]desktopObservedTurn)
		case len(path) == 2:
			target = new(desktopObservedTurn)
		case len(path) == 3 && (path[2] == "turnId" || path[2] == "status"):
			target = new(string)
		}
	case "turnHistory":
		switch {
		case len(path) == 1:
			target = new(*desktopObservedCanonical)
		case len(path) == 2 && path[1] == "kind":
			target = new(string)
		case len(path) >= 2 && path[1] == "history":
			switch {
			case len(path) == 2:
				target = new(*desktopObservedHistory)
			case path[2] == "entitiesByKey":
				switch {
				case len(path) == 3:
					target = new(map[string]desktopObservedTurn)
				case len(path) == 4:
					target = new(desktopObservedTurn)
				case len(path) == 5 && (path[4] == "turnId" || path[4] == "status"):
					target = new(string)
				}
			case path[2] == "islands":
				switch {
				case len(path) == 3:
					target = new([]desktopObservedIsland)
				case len(path) == 4:
					target = new(desktopObservedIsland)
				case len(path) == 5 && path[4] == "entries":
					target = new([]desktopObservedEntry)
				case len(path) == 6 && path[4] == "entries":
					target = new(desktopObservedEntry)
				case len(path) == 7 && path[4] == "entries" && path[6] == "value":
					target = new(string)
				}
			}
		}
	}
	if target == nil {
		return nil, false, nil
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return nil, true, err
	}
	encoded, err := json.Marshal(target)
	if err != nil || len(encoded) > desktopObservedTurnMetadataLimit {
		return nil, true, errors.New("observed turn metadata exceeds bounds")
	}
	return encoded, true, nil
}

func (p *desktopProjection) patchTurnMetadata(patch desktopPatch) {
	if len(patch.Path) >= 3 && patch.Path[0] == "turnHistory" && patch.Path[1] == "history" && patch.Path[2] == "generation" {
		p.turnMetadata, p.activeTurnID = nil, ""
		return
	}
	value, relevant, err := desktopTurnMetadataValue(patch.Path, patch.Value)
	if patch.Op == "remove" {
		// Determine whether this removal affects proof without decoding a value.
		_, relevant, _ = desktopTurnMetadataValue(patch.Path, json.RawMessage(`null`))
		err = nil
	}
	if !relevant {
		return
	}
	if err != nil || len(p.turnMetadata) == 0 {
		p.turnMetadata, p.activeTurnID = nil, ""
		return
	}
	patch.Value = value
	updated, _, err := applyDesktopHistoryPatches(p.turnMetadata, []desktopPatch{patch})
	if err != nil || len(updated) > desktopObservedTurnMetadataLimit {
		p.turnMetadata, p.activeTurnID = nil, ""
		return
	}
	p.turnMetadata = updated
	p.activeTurnID = desktopObservedActiveTurn(updated)
}

func desktopObservedActiveTurn(raw json.RawMessage) string {
	var state map[string]any
	if len(raw) == 0 || len(raw) > desktopObservedTurnMetadataLimit || json.Unmarshal(raw, &state) != nil {
		return ""
	}
	turns, _, _, err := historyChosenTurns(state)
	if err != nil || len(turns) > desktopHistoryTurnLimit {
		return ""
	}
	if state["turnHistory"] != nil {
		if transient, ok := state["turns"].([]any); ok {
			turns = append(turns, transient...)
		}
	}
	if len(turns) > desktopHistoryTurnLimit {
		return ""
	}
	active, seen := "", make(map[string]string)
	for _, value := range turns {
		turn, ok := value.(map[string]any)
		if !ok {
			return ""
		}
		id, _ := turn["turnId"].(string)
		status, _ := turn["status"].(string)
		if status != "inProgress" && status != "completed" && status != "failed" && status != "interrupted" {
			return ""
		}
		if id == "" {
			if status == "inProgress" {
				return ""
			}
			continue
		}
		if !protocol.ValidTurnID(id) {
			return ""
		}
		if previous, exists := seen[id]; exists {
			if previous != status {
				return ""
			}
			continue
		}
		seen[id] = status
		if turn["status"] == "inProgress" {
			if active != "" {
				return ""
			}
			active = id
		}
	}
	return active
}
