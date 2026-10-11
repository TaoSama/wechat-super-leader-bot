package codex

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

const (
	desktopReferenceItemBytes = 1 << 20
	desktopRepeatedReferences = 10000
	desktopReferenceKey       = "private-canonical-entity"
)

func controlReferenceState(text string, islandEntryCounts ...int) map[string]any {
	state := controlState()
	turn := map[string]any{"turnId": "target", "status": "completed", "items": []any{map[string]any{"type": "agentMessage", "text": text}}}
	islands := make([]any, 0, len(islandEntryCounts))
	for _, count := range islandEntryCounts {
		entries := make([]any, count)
		for index := range count {
			entries[index] = map[string]string{"value": desktopReferenceKey}
		}
		islands = append(islands, map[string]any{"entries": entries})
	}
	state["turnHistory"] = map[string]any{"kind": "canonical", "history": map[string]any{
		"islands": islands, "entitiesByKey": map[string]any{desktopReferenceKey: turn},
	}}
	return state
}

func TestDesktopControlCanonicalRepeatedReferencesRejectedBeforeExpansion(t *testing.T) {
	for _, test := range []struct {
		name   string
		counts []int
	}{
		{"same-island", []int{desktopRepeatedReferences}},
		{"cross-island", []int{1, desktopRepeatedReferences - 1}},
	} {
		t.Run(test.name, func(t *testing.T) {
			state := controlReferenceState(strings.Repeat("p", desktopReferenceItemBytes), test.counts...)
			raw, err := json.Marshal(state)
			if err != nil {
				t.Fatal(err)
			}
			if len(raw) >= desktopInboundFrameLimit {
				t.Fatal("reference fixture must fit the inbound byte boundary")
			}
			decoded, err := decodeDesktopControlState(raw)
			if err != nil {
				t.Fatalf("reference fixture must pass byte, node, and depth guards: %v", err)
			}
			turns, err := decoded.recordedTurns()
			if turns != nil || !errors.Is(err, errDesktopCanonicalDuplicateReference) {
				t.Fatalf("canonical shared references expanded: turns=%d error=%v", len(turns), err)
			}
			if strings.Contains(err.Error(), desktopReferenceKey) {
				t.Fatal("duplicate reference error exposed the canonical key")
			}
		})
	}
}

func TestDesktopControlCanonicalRepeatedReferencesInspectionIsBounded(t *testing.T) {
	state := controlReferenceState(strings.Repeat("p", desktopReferenceItemBytes), desktopRepeatedReferences)
	path := desktopFixture(t, func(c *desktopConn) error {
		if err := controlHandshake(c); err != nil {
			return err
		}
		if err := controlSnapshot(c, state, nil); err != nil {
			return err
		}
		return controlExpectClosed(c)
	})
	controller := NewDesktopController(path)
	ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := controller.InspectTurn(ctx, "session", "target")
		done <- err
	}()
	select {
	case err := <-done:
		if !errors.Is(err, errDesktopCanonicalDuplicateReference) {
			t.Fatalf("repeated-reference inspection = %v", err)
		}
	case <-time.After(desktopTestTimeout):
		t.Fatal("inspection did not reject repeated references within its bounded deadline")
	}
	if len(controller.slots) != 0 {
		t.Fatal("rejected reference inspection retained a control slot")
	}
}

func TestDesktopControlCanonicalSingleAndDualRepresentations(t *testing.T) {
	const output = "exact canonical output"
	for _, test := range []struct {
		name      string
		transient bool
		conflict  bool
	}{
		{name: "single-canonical"},
		{name: "identical-transient-and-canonical", transient: true},
		{name: "conflicting-transient-and-canonical", transient: true, conflict: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			state := controlReferenceState(output, 1)
			if test.transient {
				text := output
				if test.conflict {
					text = "different transient output"
				}
				state["turns"] = []any{map[string]any{"turnId": "target", "status": "completed", "items": []any{map[string]any{"type": "agentMessage", "text": text}}}}
			}
			path := desktopFixture(t, func(c *desktopConn) error {
				if err := controlHandshake(c); err != nil {
					return err
				}
				if err := controlSnapshot(c, state, nil); err != nil {
					return err
				}
				return controlExpectClosed(c)
			})
			ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
			defer cancel()
			observation, err := NewDesktopController(path).InspectTurn(ctx, "session", "target")
			if test.conflict {
				if err == nil || err.Error() != "conflicting exact desktop turn representations" {
					t.Fatalf("conflicting representations accepted or reclassified: %v", err)
				}
				return
			}
			if err != nil || observation.Output != output || observation.Status != "completed" {
				t.Fatalf("valid canonical inspection = %+v, error=%v", observation, err)
			}
		})
	}
}
