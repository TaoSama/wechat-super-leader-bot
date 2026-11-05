package desktop

import "strings"

// These schemas describe only the metadata consumed by the observer. A value
// of the wrong JSON type is preserved as an invalid type, rather than coerced
// into a valid identity, null override or empty turn collection.
type desktopJSONSchema uint8

const (
	desktopJSONSkip desktopJSONSchema = iota
	desktopJSONAtom
	desktopJSONSoftAtom
	desktopJSONEnvelope
	desktopJSONParams
	desktopJSONChange
	desktopJSONState
	desktopJSONStatus
	desktopJSONCollaboration
	desktopJSONSettings
	desktopJSONTurn
	desktopJSONTurns
	desktopJSONCanonical
	desktopJSONHistory
	desktopJSONEntities
	desktopJSONIsland
	desktopJSONIslands
	desktopJSONEntry
	desktopJSONEntries
	desktopJSONPatch
	desktopJSONPatches
	desktopJSONPath
	desktopJSONAtoms
	desktopJSONInvalid
)

func (s desktopJSONSchema) field(key string) desktopJSONSchema {
	if child := s.exactField(key); child != desktopJSONSkip {
		return child
	}
	// The existing struct decoders accept folded field names. Silently dropping
	// an alias could remove an overriding identity/status and manufacture proof.
	// Exact-map model/settings fields deliberately do not participate.
	for _, name := range s.structFields() {
		if strings.EqualFold(name, key) {
			return desktopJSONInvalid
		}
	}
	return desktopJSONSkip
}

func (s desktopJSONSchema) structFields() []string {
	switch s {
	case desktopJSONChange:
		return []string{"type", "revision", "baseRevision", "conversationState", "patches"}
	case desktopJSONState:
		return []string{"id", "hostId", "threadRuntimeStatus"}
	case desktopJSONStatus:
		return []string{"type"}
	case desktopJSONTurn:
		return []string{"turnId", "status"}
	case desktopJSONCanonical:
		return []string{"kind", "history"}
	case desktopJSONHistory:
		return []string{"islands", "entitiesByKey"}
	case desktopJSONIsland:
		return []string{"entries"}
	case desktopJSONEntry:
		return []string{"value"}
	}
	return nil
}

func (s desktopJSONSchema) exactField(key string) desktopJSONSchema {
	switch s {
	case desktopJSONEnvelope:
		switch key {
		case "type", "requestId", "sourceClientId", "targetClientId", "version", "method", "resultType", "handledByClientId", "timeoutMs":
			return desktopJSONAtom
		case "targetClientIds":
			return desktopJSONAtoms
		case "params":
			return desktopJSONParams
		}
	case desktopJSONParams:
		switch key {
		case "conversationId", "hostId", "following", "clientId", "clientType", "status":
			return desktopJSONAtom
		case "change":
			return desktopJSONChange
		}
	case desktopJSONChange:
		switch key {
		case "type", "revision", "baseRevision":
			return desktopJSONAtom
		case "conversationState":
			return desktopJSONState
		case "patches":
			return desktopJSONPatches
		}
	case desktopJSONState:
		switch key {
		case "id", "hostId":
			return desktopJSONAtom
		case "threadRuntimeStatus":
			return desktopJSONStatus
		case "latestModel", "latestReasoningEffort", "modelProvider":
			return desktopJSONSoftAtom
		case "latestCollaborationMode":
			return desktopJSONCollaboration
		case "turns":
			return desktopJSONTurns
		case "turnHistory":
			return desktopJSONCanonical
		}
	case desktopJSONStatus:
		if key == "type" {
			return desktopJSONSoftAtom
		}
	case desktopJSONCollaboration:
		if key == "settings" {
			return desktopJSONSettings
		}
	case desktopJSONSettings:
		if key == "model" {
			return desktopJSONSoftAtom
		}
	case desktopJSONTurn:
		if key == "turnId" || key == "status" {
			return desktopJSONSoftAtom
		}
	case desktopJSONCanonical:
		switch key {
		case "kind":
			return desktopJSONSoftAtom
		case "history":
			return desktopJSONHistory
		}
	case desktopJSONHistory:
		switch key {
		case "entitiesByKey":
			return desktopJSONEntities
		case "islands":
			return desktopJSONIslands
		}
	case desktopJSONEntities:
		return desktopJSONTurn
	case desktopJSONIsland:
		if key == "entries" {
			return desktopJSONEntries
		}
	case desktopJSONEntry:
		if key == "value" {
			return desktopJSONSoftAtom
		}
	}
	return desktopJSONSkip
}

func (s desktopJSONSchema) element() desktopJSONSchema {
	switch s {
	case desktopJSONTurns:
		return desktopJSONTurn
	case desktopJSONIslands:
		return desktopJSONIsland
	case desktopJSONEntries:
		return desktopJSONEntry
	case desktopJSONPatches:
		return desktopJSONPatch
	case desktopJSONPath, desktopJSONAtoms:
		return desktopJSONAtom
	}
	return desktopJSONSkip
}

func (s desktopJSONSchema) soft() bool {
	switch s {
	case desktopJSONSoftAtom, desktopJSONStatus, desktopJSONCollaboration, desktopJSONSettings,
		desktopJSONTurn, desktopJSONTurns, desktopJSONCanonical, desktopJSONHistory,
		desktopJSONEntities, desktopJSONIsland, desktopJSONIslands, desktopJSONEntry, desktopJSONEntries:
		return true
	}
	return false
}

func desktopJSONPatchSchema(path []any) desktopJSONSchema {
	if len(path) == 0 {
		return desktopJSONState
	}
	switch path[0] {
	case "threadRuntimeStatus":
		if len(path) == 1 {
			return desktopJSONStatus
		}
		if len(path) == 2 && path[1] == "type" {
			return desktopJSONSoftAtom
		}
	case "latestModel", "latestReasoningEffort", "modelProvider":
		if len(path) == 1 {
			return desktopJSONSoftAtom
		}
	case "latestCollaborationMode":
		if len(path) == 1 {
			return desktopJSONCollaboration
		}
		if path[1] == "settings" {
			if len(path) == 2 {
				return desktopJSONSettings
			}
			if len(path) == 3 && path[2] == "model" {
				return desktopJSONSoftAtom
			}
		}
	}
	switch desktopTurnMetadataTarget(path).(type) {
	case *string:
		return desktopJSONSoftAtom
	case *[]desktopObservedTurn:
		return desktopJSONTurns
	case *desktopObservedTurn:
		return desktopJSONTurn
	case **desktopObservedCanonical:
		return desktopJSONCanonical
	case **desktopObservedHistory:
		return desktopJSONHistory
	case *map[string]desktopObservedTurn:
		return desktopJSONEntities
	case *[]desktopObservedIsland:
		return desktopJSONIslands
	case *desktopObservedIsland:
		return desktopJSONIsland
	case *[]desktopObservedEntry:
		return desktopJSONEntries
	case *desktopObservedEntry:
		return desktopJSONEntry
	}
	return desktopJSONSkip
}
