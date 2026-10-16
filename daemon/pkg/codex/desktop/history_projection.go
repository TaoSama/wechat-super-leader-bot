package desktop

import (
	"encoding/json"
	"errors"
	"unicode/utf8"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/internal/threadstate"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	desktopHistoryItemLimit = 32768
	desktopHistoryTurnLimit = 16384
)

type desktopHistoryView struct {
	session             protocol.Session
	items               []protocol.HistoryItem
	complete            bool
	canonicalGeneration string
}

func historyError(message string) error { return errors.New(message) }

func historyObject(value any) (map[string]any, error) {
	object, ok := value.(map[string]any)
	if !ok || object == nil {
		return nil, historyError(protocol.HistoryFailed)
	}
	return object, nil
}

// Missing/null pagination retains the native legacy default. Present bad types
// never inherit that default; an explicit false means some recorded items are absent.
func historyPaginationComplete(value any) (bool, error) {
	if value == nil {
		return true, nil
	}
	object, err := historyObject(value)
	if err != nil {
		return false, err
	}
	loaded, exists := object["hasLoadedOldest"]
	if !exists || loaded == nil {
		return true, nil
	}
	result, ok := loaded.(bool)
	if !ok {
		return false, historyError(protocol.HistoryFailed)
	}
	return result, nil
}

func historyOrdinary(state map[string]any) bool {
	source, exists := state["threadSource"]
	return exists && (source == nil || source == "user") && state["resumeState"] == "resumed" &&
		state["mode"] == "default"
}

func historyChosenTurns(state map[string]any) ([]any, bool, string, error) {
	if state["turnHistory"] == nil {
		turns, ok := state["turns"].([]any)
		if !ok {
			return nil, false, "", historyError(protocol.HistoryFailed)
		}
		complete, err := historyPaginationComplete(state["turnsPagination"])
		return turns, complete && state["resumeState"] == "resumed", "legacy", err
	}
	turnHistory, err := historyObject(state["turnHistory"])
	if err != nil || turnHistory["kind"] != "canonical" {
		return nil, false, "", historyError(protocol.HistoryFailed)
	}
	history, err := historyObject(turnHistory["history"])
	if err != nil {
		return nil, false, "", err
	}
	islands, ok := history["islands"].([]any)
	entities, entityErr := historyObject(history["entitiesByKey"])
	complete, validComplete := history["isComplete"].(bool)
	if !ok || entityErr != nil || (!validComplete && history["isComplete"] != nil) {
		return nil, false, "", historyError(protocol.HistoryFailed)
	}
	if len(islands) > desktopHistoryTurnLimit || len(entities) > desktopHistoryTurnLimit {
		return nil, false, "", historyError(protocol.HistoryTooLarge)
	}
	encodedGeneration, err := json.Marshal(history["generation"])
	if err != nil {
		return nil, false, "", historyError(protocol.HistoryFailed)
	}
	turns := []any{}
	seen := map[string]bool{}
	for _, rawIsland := range islands {
		island, err := historyObject(rawIsland)
		if err != nil {
			return nil, false, "", err
		}
		entries, ok := island["entries"].([]any)
		if !ok {
			return nil, false, "", historyError(protocol.HistoryFailed)
		}
		if len(entries) > desktopHistoryTurnLimit-len(turns) {
			return nil, false, "", historyError(protocol.HistoryTooLarge)
		}
		for _, rawEntry := range entries {
			entry, err := historyObject(rawEntry)
			if err != nil {
				return nil, false, "", err
			}
			key, ok := entry["value"].(string)
			turn, found := entities[key]
			if !ok || key == "" || !found || seen[key] {
				return nil, false, "", historyError(protocol.HistoryFailed)
			}
			seen[key] = true
			turns = append(turns, turn)
		}
	}
	return turns, complete && len(islands) == 1, "canonical:" + string(encodedGeneration), nil
}

// This selects the owner's complete recorded history, not its transient UI turns.
func projectDesktopHistory(state map[string]any, sessionID string) (desktopHistoryView, error) {
	view := desktopHistoryView{items: []protocol.HistoryItem{}}
	if state["id"] != sessionID || state["hostId"] != "local" {
		return view, historyError(protocol.HistoryFailed)
	}
	if !historyOrdinary(state) {
		return view, historyError(protocol.HistoryUnavailable)
	}
	turns, complete, generation, err := historyChosenTurns(state)
	if err != nil {
		return view, err
	}
	if len(turns) > desktopHistoryTurnLimit {
		return view, historyError(protocol.HistoryTooLarge)
	}
	view.complete, view.canonicalGeneration = complete, generation
	seenTurns, turnSet := map[string]bool{}, map[string]bool{}
	typedTurns := make([]map[string]any, 0, len(turns))
	nativeUsers := map[string]string{}
	rawIDs := map[string]bool{}
	itemCount := 0
	for _, rawTurn := range turns {
		turn, err := historyObject(rawTurn)
		if err != nil {
			return view, err
		}
		items, ok := turn["items"].([]any)
		if !ok {
			return view, historyError(protocol.HistoryFailed)
		}
		itemCount += len(items)
		if itemCount > desktopHistoryItemLimit {
			return view, historyError(protocol.HistoryTooLarge)
		}
		loaded, err := historyPaginationComplete(turn["itemsPagination"])
		if err != nil {
			return view, err
		}
		view.complete = view.complete && loaded
		id, hasID := turn["turnId"].(string)
		if turn["turnId"] != nil && (!hasID || !protocol.ValidTurnID(id)) {
			return view, historyError(protocol.HistoryFailed)
		}
		if id == "" {
			continue
		} // Never fabricate an accepted native identity for a local placeholder.
		if seenTurns[id] {
			return view, historyError(protocol.HistoryFailed)
		}
		seenTurns[id], turnSet[id] = true, true
		typedTurns = append(typedTurns, turn)
		for _, rawItem := range items {
			item, err := historyObject(rawItem)
			if err != nil {
				return view, err
			}
			itemID, validID := item["id"].(string)
			kind, validKind := item["type"].(string)
			if !validID || !validDesktopHistoryItemID(itemID) || rawIDs[itemID] || !validKind || kind == "" {
				return view, historyError(protocol.HistoryFailed)
			}
			rawIDs[itemID] = true
			if item["type"] == "userMessage" {
				itemID, ok := item["id"].(string)
				if !ok || !validDesktopHistoryItemID(itemID) || nativeUsers[itemID] != "" {
					return view, historyError(protocol.HistoryFailed)
				}
				nativeUsers[itemID] = id
			}
		}
	}
	seenItems := map[string]bool{}
	for _, turn := range typedTurns {
		turnID := turn["turnId"].(string)
		for _, rawItem := range turn["items"].([]any) {
			item, err := historyObject(rawItem)
			if err != nil {
				return view, err
			}
			if id, ok := item["id"].(string); !ok || !validDesktopHistoryItemID(id) {
				return view, historyError(protocol.HistoryFailed)
			}
			if item["type"] == "userMessage" {
				if _, ok := item["content"].([]any); !ok {
					return view, historyError(protocol.HistoryFailed)
				}
			}
			if item["type"] == "agentMessage" {
				if _, ok := item["text"].(string); !ok {
					return view, historyError(protocol.HistoryFailed)
				}
			}
			outputTurnID := turnID
			if item["type"] == "steeringUserMessage" {
				serverID, ok := item["serverUserMessageId"].(string)
				if item["status"] != "accepted" || !ok || !validDesktopHistoryItemID(serverID) {
					continue
				}
				if nativeUsers[serverID] != "" {
					continue
				}
				if target := item["targetTurnId"]; target != nil {
					targetID, ok := target.(string)
					if !ok || !turnSet[targetID] || targetID != turnID {
						// Cross-turn local reconciliation is outside recorded-history
						// projection; fail rather than guessing its timeline placement.
						return view, historyError(protocol.HistoryFailed)
					}
					outputTurnID = targetID
				}
				if _, ok := item["input"].([]any); !ok {
					return view, historyError(protocol.HistoryFailed)
				}
				item = map[string]any{"id": serverID, "type": "userMessage", "content": item["input"]}
			}
			wrapper := map[string]any{"item": item, "turnId": outputTurnID}
			historyItemTimes(wrapper, turn, item)
			public, include := threadstate.PublicHistoryItem(wrapper)
			if !include {
				continue
			}
			if !validDesktopHistoryItemID(public.ID) || seenItems[public.ID] {
				return view, historyError(protocol.HistoryFailed)
			}
			seenItems[public.ID] = true // Cross-turn collisions are rejected, never silently merged by Web.
			view.items = append(view.items, public)
		}
	}
	view.session = desktopHistorySession(sessionID)
	return view, nil
}

func validDesktopHistoryItemID(id string) bool {
	return protocol.ValidHistoryIdentity(id) && protocol.ValidTurnID(id) && utf8.ValidString(id)
}

func historyItemTimes(wrapper, turn, item map[string]any) {
	id, _ := item["id"].(string)
	keys := map[string]string{}
	switch item["type"] {
	case "agentMessage":
		keys = map[string]string{"startedAtMs": "aeonAssistantMessageStartedAtMsById", "completedAtMs": "agentMessageCompletedAtMsById"}
	case "commandExecution":
		keys["startedAtMs"] = "commandExecutionStartedAtMsById"
	case "contextCompaction":
		wrapper["startedAtMs"] = item["startedAtMs"]
	}
	for field, key := range keys {
		if times, ok := turn[key].(map[string]any); ok {
			wrapper[field] = times[id]
		}
	}
}

func desktopHistorySession(id string) protocol.Session {
	// Desktop history does not establish control-socket inventory or native load
	// state. The caller may supplement these fields from its exact native cache.
	loaded := false
	return protocol.Session{ID: id, Provider: codex.ProviderCodexApp, Status: "unknown", Capabilities: []protocol.ActionType{protocol.ActionRead}, Loaded: &loaded}
}
