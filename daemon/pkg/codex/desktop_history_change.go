package codex

import (
	"bytes"
	"encoding/json"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func (entry *desktopHistoryEntry) change(raw json.RawMessage) error {
	var params map[string]any
	if json.Unmarshal(raw, &params) != nil || params["conversationId"] != entry.sessionID || params["hostId"] != "local" {
		return historyError(protocol.HistoryFailed)
	}
	change, err := historyObject(params["change"])
	if err != nil {
		return err
	}
	revision, ok := historyRevision(change["revision"])
	if !ok {
		return historyError(protocol.HistoryFailed)
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	var encoded []byte
	var state map[string]any
	switch change["type"] {
	case "snapshot":
		if entry.ready && revision < entry.revision {
			return historyError(protocol.HistoryContextExpired)
		}
		encoded, err = json.Marshal(change["conversationState"])
		if err != nil {
			return historyError(protocol.HistoryFailed)
		}
		state, err = decodeDesktopHistoryState(encoded)
		if err != nil {
			return err
		}
		if entry.ready && revision == entry.revision && !bytes.Equal(encoded, entry.raw) {
			return historyError(protocol.HistoryContextExpired)
		}
	case "patches":
		base, ok := historyRevision(change["baseRevision"])
		if !entry.ready || !ok || base != entry.revision || revision <= entry.revision {
			return historyError(protocol.HistoryContextExpired)
		}
		patches, err := historyPatches(change["patches"])
		if err != nil {
			return err
		}
		encoded, state, err = applyDesktopHistoryPatches(entry.raw, patches)
		if err != nil {
			return err
		}
		// Canonical JSON permits exact same-revision snapshots to compare with
		// patch-derived state, independently of object encoding order.
		encoded, err = json.Marshal(state)
		if err != nil {
			return historyError(protocol.HistoryFailed)
		}
	default:
		return historyError(protocol.HistoryFailed)
	}
	if len(encoded) > desktopHistoryRawLimit {
		return historyError(protocol.HistoryTooLarge)
	}
	view, err := projectDesktopHistory(state, entry.sessionID)
	if err != nil {
		return err
	}
	if entry.ready && entry.view.canonicalGeneration != view.canonicalGeneration {
		return historyError(protocol.HistoryContextExpired)
	}
	if view.complete {
		if len(view.items) < len(entry.order) {
			return historyError(protocol.HistoryContextExpired)
		}
		for i, anchor := range entry.order {
			item := view.items[i]
			if item.TurnID != anchor.turnID || item.ID != anchor.itemID {
				return historyError(protocol.HistoryContextExpired)
			}
		}
		entry.order = make([]desktopHistoryAnchor, len(view.items))
		for i, item := range view.items {
			entry.order[i] = desktopHistoryAnchor{turnID: item.TurnID, itemID: item.ID}
		}
	}
	entry.raw, entry.view, entry.ready, entry.revision = encoded, view, true, revision
	entry.notifyLocked()
	return nil
}

func historyPatches(value any) ([]desktopPatch, error) {
	values, ok := value.([]any)
	if !ok {
		return nil, historyError(protocol.HistoryFailed)
	}
	if len(values) > desktopHistoryPatchLimit {
		return nil, historyError(protocol.HistoryTooLarge)
	}
	patches := make([]desktopPatch, 0, len(values))
	for _, value := range values {
		object, err := historyObject(value)
		if err != nil {
			return nil, err
		}
		op, ok := object["op"].(string)
		path, pathOK := object["path"].([]any)
		if !ok || !pathOK {
			return nil, historyError(protocol.HistoryFailed)
		}
		patch := desktopPatch{Op: op, Path: path}
		if op != "remove" {
			value, exists := object["value"]
			if !exists {
				return nil, historyError(protocol.HistoryFailed)
			}
			patch.Value, err = json.Marshal(value)
			if err != nil {
				return nil, historyError(protocol.HistoryFailed)
			}
		}
		patches = append(patches, patch)
	}
	return patches, nil
}
