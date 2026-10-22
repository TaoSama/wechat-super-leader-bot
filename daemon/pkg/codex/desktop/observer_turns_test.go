package desktop

import (
	"encoding/json"
	"strings"
	"testing"
)

func observedTurnProjection(t *testing.T, state map[string]any) *desktopProjection {
	t.Helper()
	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	var decoded desktopRuntimeState
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	p := &desktopProjection{}
	if err := p.snapshot("session", &decoded); err != nil {
		t.Fatal(err)
	}
	return p
}

func observedTurnPatch(t *testing.T, p *desktopProjection, op string, path []any, value any) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.patch("session", desktopPatch{Op: op, Path: path, Value: raw}); err != nil {
		t.Fatal(err)
	}
}

func TestDesktopObserverRetainsOnlyExactUniqueActiveTurnMetadata(t *testing.T) {
	for _, canonical := range []bool{false, true} {
		active := historyTestTurn("active", historyTestItem("item", "agentMessage", "PRIVATE OUTPUT"))
		active["status"] = "inProgress"
		p := observedTurnProjection(t, historyTestState(canonical, historyTestTurn("old"), active))
		if p.activeTurnID != "active" || strings.Contains(string(p.turnMetadata), "PRIVATE") || strings.Contains(string(p.turnMetadata), "items") {
			t.Fatalf("unsafe metadata projection: active=%q", p.activeTurnID)
		}
		second := historyTestTurn("other")
		second["status"] = "inProgress"
		if got := observedTurnProjection(t, historyTestState(canonical, active, second)).activeTurnID; got != "" {
			t.Fatal("ambiguous active identity was guessed")
		}
		active["turnId"] = "invalid id"
		if got := observedTurnProjection(t, historyTestState(canonical, active)).activeTurnID; got != "" {
			t.Fatal("invalid active identity was accepted")
		}
	}
}

func TestDesktopObserverCanonicalProofTracksMetadataAndMembershipPatches(t *testing.T) {
	active := historyTestTurn("active")
	active["status"] = "inProgress"
	p := observedTurnProjection(t, historyTestState(true, active))
	base := []any{"turnHistory", "history", "entitiesByKey", "k"}
	observedTurnPatch(t, p, "replace", append(append([]any{}, base...), "items"), []any{historyTestItem("new", "agentMessage", "PRIVATE")})
	if p.activeTurnID != "active" || strings.Contains(string(p.turnMetadata), "PRIVATE") {
		t.Fatal("body patch changed retained turn proof")
	}
	observedTurnPatch(t, p, "replace", append(append([]any{}, base...), "status"), "completed")
	if p.activeTurnID != "" {
		t.Fatal("completed patch retained active proof")
	}
	observedTurnPatch(t, p, "replace", append(append([]any{}, base...), "status"), "inProgress")
	if p.activeTurnID != "active" {
		t.Fatal("fresh exact inProgress patch was ignored")
	}
	observedTurnPatch(t, p, "remove", []any{"turnHistory", "history", "islands", float64(0), "entries", float64(0)}, nil)
	if p.activeTurnID != "" {
		t.Fatal("removed canonical membership retained active proof")
	}
	p = observedTurnProjection(t, historyTestState(true, active))
	observedTurnPatch(t, p, "remove", append(base, "turnId"), nil)
	if p.activeTurnID != "" {
		t.Fatal("removed turn identity retained proof")
	}
	p = observedTurnProjection(t, historyTestState(true, active))
	observedTurnPatch(t, p, "replace", []any{"turnHistory", "history", "generation"}, "new")
	if p.activeTurnID != "" || len(p.turnMetadata) != 0 {
		t.Fatal("generation change retained old proof")
	}
}

func TestDesktopObserverLegacyProofTracksArrayShiftAndInvalidMetadata(t *testing.T) {
	active := historyTestTurn("active")
	active["status"] = "inProgress"
	p := observedTurnProjection(t, historyTestState(false, historyTestTurn("old"), active))
	observedTurnPatch(t, p, "remove", []any{"turns", float64(0)}, nil)
	if p.activeTurnID != "active" {
		t.Fatal("array shift lost exact active metadata")
	}
	observedTurnPatch(t, p, "replace", []any{"turns", float64(0), "status"}, "interrupted")
	if p.activeTurnID != "" {
		t.Fatal("terminal patch retained active proof")
	}
	observedTurnPatch(t, p, "replace", []any{"turns"}, "invalid shape")
	if p.activeTurnID != "" || len(p.turnMetadata) != 0 || p.status != "active" {
		t.Fatal("invalid history must revoke only exact turn proof")
	}
}

func TestDesktopObserverRevokesAmbiguousOrUnreferencedActiveTurnProof(t *testing.T) {
	active := historyTestTurn("active")
	active["status"] = "inProgress"
	for _, tc := range []struct {
		name   string
		change func(map[string]any)
	}{
		{"unknown active identity", func(s map[string]any) { s["turns"] = []any{map[string]any{"turnId": "", "status": "inProgress"}} }},
		{"conflicting same ID", func(s map[string]any) { s["turns"] = []any{historyTestTurn("active")} }},
		{"different active ID", func(s map[string]any) {
			other := historyTestTurn("other")
			other["status"] = "inProgress"
			s["turns"] = []any{other}
		}},
		{"unknown recorded status", func(s map[string]any) { s["turns"] = []any{map[string]any{"turnId": "other", "status": "future"}} }},
		{"removed canonical entity", func(s map[string]any) { delete(historyTestCanonical(s)["entitiesByKey"].(map[string]any), "k") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state := historyTestState(true, active)
			tc.change(state)
			if p := observedTurnProjection(t, state); p.activeTurnID != "" {
				t.Fatal("ambiguous owner metadata granted exact turn proof")
			}
		})
	}
	state := historyTestState(true, active)
	state["turns"] = []any{active}
	if observedTurnProjection(t, state).activeTurnID != "active" {
		t.Fatal("identical canonical/transient identity could not establish exact proof")
	}
	state = historyTestState(true, historyTestTurn("old"))
	historyTestCanonical(state)["entitiesByKey"].(map[string]any)["orphan"] = active
	if observedTurnProjection(t, state).activeTurnID != "" {
		t.Fatal("unreferenced canonical entity granted proof")
	}
}

func TestDesktopObserverParentRemovalAndMetadataBoundsRevokeProof(t *testing.T) {
	active := historyTestTurn("active")
	active["status"] = "inProgress"
	for _, path := range [][]any{{"turnHistory"}, {"turnHistory", "history"}, {"turnHistory", "history", "entitiesByKey"}, {"turnHistory", "history", "entitiesByKey", "k"}} {
		p := observedTurnProjection(t, historyTestState(true, active))
		observedTurnPatch(t, p, "remove", path, nil)
		if p.activeTurnID != "" {
			t.Fatalf("parent removal retained proof: %v", path)
		}
	}
	p := observedTurnProjection(t, historyTestState(false, active))
	observedTurnPatch(t, p, "remove", []any{"turns"}, nil)
	if p.activeTurnID != "" {
		t.Fatal("removed legacy turns retained proof")
	}
	oversized := historyTestTurn(strings.Repeat("x", desktopObservedTurnMetadataLimit))
	oversized["status"] = "inProgress"
	p = observedTurnProjection(t, historyTestState(false, oversized))
	if p.activeTurnID != "" || len(p.turnMetadata) != 0 || p.status != "active" {
		t.Fatal("oversized turn metadata retained proof or revoked scalar runtime state")
	}
}
