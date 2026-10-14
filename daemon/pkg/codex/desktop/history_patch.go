package desktop

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	jsonpatch "github.com/evanphx/json-patch/v5"
)

const (
	desktopHistoryPatchLimit     = 4096
	desktopHistoryDepthLimit     = 64
	desktopHistoryNodeLimit      = 250000
	desktopHistoryPatchWorkLimit = 256 * 1024 * 1024
)

func decodeDesktopHistoryState(raw []byte) (map[string]any, error) {
	if len(raw) > desktopHistoryRawLimit {
		return nil, historyError(protocol.HistoryTooLarge)
	}
	var state map[string]any
	if json.Unmarshal(raw, &state) != nil || state == nil {
		return nil, historyError(protocol.HistoryFailed)
	}
	count := 0
	if err := boundDesktopHistoryTree(state, 0, &count); err != nil {
		return nil, err
	}
	return state, nil
}

func boundDesktopHistoryTree(value any, depth int, count *int) error {
	*count++
	if depth > desktopHistoryDepthLimit || *count > desktopHistoryNodeLimit {
		return historyError(protocol.HistoryTooLarge)
	}
	switch object := value.(type) {
	case map[string]any:
		for _, child := range object {
			if err := boundDesktopHistoryTree(child, depth+1, count); err != nil {
				return err
			}
		}
	case []any:
		for _, child := range object {
			if err := boundDesktopHistoryTree(child, depth+1, count); err != nil {
				return err
			}
		}
	}
	return nil
}

// Immer paths keep object keys and array indices typed. Validate those types
// against each current document before translating to RFC 6901 for the library.
func historyPatchPointer(state map[string]any, patch desktopPatch) (string, error) {
	if patch.Path == nil || (patch.Op != "add" && patch.Op != "replace" && patch.Op != "remove") ||
		(patch.Op != "remove" && len(patch.Value) == 0) {
		return "", historyError(protocol.HistoryFailed)
	}
	if len(patch.Path) > desktopHistoryDepthLimit {
		return "", historyError(protocol.HistoryTooLarge)
	}
	if len(patch.Path) == 0 {
		if patch.Op == "remove" {
			return "", historyError(protocol.HistoryFailed)
		}
		return "", nil
	}
	if patch.Path[0] == "id" || patch.Path[0] == "hostId" {
		return "", historyError(protocol.HistoryContextExpired)
	}
	parts := make([]string, 0, len(patch.Path))
	var current any = state
	for i, segment := range patch.Path {
		last := i == len(patch.Path)-1
		switch object := current.(type) {
		case map[string]any:
			key, ok := segment.(string)
			if !ok {
				return "", historyError(protocol.HistoryFailed)
			}
			child, exists := object[key]
			if !exists && (!last || patch.Op != "add") {
				return "", historyError(protocol.HistoryFailed)
			}
			current = child
			parts = append(parts, strings.ReplaceAll(strings.ReplaceAll(key, "~", "~0"), "/", "~1"))
		case []any:
			index, ok := segment.(float64)
			if !ok || math.IsNaN(index) || math.IsInf(index, 0) || index < 0 || index > maxDesktopRevision || math.Trunc(index) != index ||
				index > float64(len(object)) || (index == float64(len(object)) && (!last || patch.Op != "add")) {
				return "", historyError(protocol.HistoryFailed)
			}
			parts = append(parts, strconv.Itoa(int(index)))
			if int(index) < len(object) {
				current = object[int(index)]
			} else {
				current = nil
			}
		default:
			return "", historyError(protocol.HistoryFailed)
		}
	}
	return "/" + strings.Join(parts, "/"), nil
}

func applyDesktopHistoryPatches(raw []byte, patches []desktopPatch) ([]byte, map[string]any, error) {
	if len(patches) > desktopHistoryPatchLimit {
		return nil, nil, historyError(protocol.HistoryTooLarge)
	}
	state, err := decodeDesktopHistoryState(raw)
	if err != nil {
		return nil, nil, err
	}
	options := jsonpatch.NewApplyOptions()
	options.SupportNegativeIndices = false
	options.AllowMissingPathOnRemove = false
	options.EnsurePathExistsOnAdd = false
	work := 0
	for _, patch := range patches {
		work += len(raw) + len(patch.Value)
		if work > desktopHistoryPatchWorkLimit {
			return nil, nil, historyError(protocol.HistoryTooLarge)
		}
		pointer, err := historyPatchPointer(state, patch)
		if err != nil {
			return nil, nil, err
		}
		operation := map[string]any{"op": patch.Op, "path": pointer}
		if patch.Op != "remove" {
			operation["value"] = patch.Value
		}
		encoded, err := json.Marshal([]any{operation})
		if err != nil {
			return nil, nil, historyError(protocol.HistoryFailed)
		}
		decoded, err := jsonpatch.DecodePatch(encoded)
		if err != nil {
			return nil, nil, historyError(protocol.HistoryFailed)
		}
		updated, err := decoded.ApplyWithOptions(raw, options)
		if err != nil {
			return nil, nil, historyError(protocol.HistoryFailed)
		}
		state, err = decodeDesktopHistoryState(updated)
		if err != nil {
			return nil, nil, err
		}
		raw = updated
	}
	return raw, state, nil
}
