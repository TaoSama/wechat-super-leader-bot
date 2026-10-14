package desktop

import (
	"encoding/json"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestDesktopModelSnapshotAndRootPatchUseExactKeys(t *testing.T) {
	for _, tc := range []struct {
		name, fields, model, provider, effort string
	}{
		{"wrong top-level case", `"LatestModel":"wrong","ModelProvider":"wrong","LatestReasoningEffort":"wrong"`, "", "", ""},
		{"top-level collisions", `"latestModel":"actual","LatestModel":"wrong","modelProvider":"provider","ModelProvider":"wrong","latestReasoningEffort":"high","LatestReasoningEffort":false`, "actual", "provider", "high"},
		{"wrong collaboration case", `"latestModel":"latest","LatestCollaborationMode":{"settings":{"model":"wrong"}}`, "latest", "", ""},
		{"wrong settings case", `"latestModel":"latest","latestCollaborationMode":{"SETTINGS":{"MODEL":"wrong"}}`, "latest", "", ""},
		{"wrong model type ignored", `"latestModel":"latest","latestCollaborationMode":{"settings":{"MODEL":42}}`, "latest", "", ""},
		{"model collision", `"latestModel":"latest","latestCollaborationMode":{"settings":{"model":"actual","MODEL":"wrong"}}`, "actual", "", ""},
		{"settings collision", `"latestModel":"latest","latestCollaborationMode":{"settings":{"model":"actual"},"SETTINGS":{"model":"wrong"}}`, "actual", "", ""},
		{"collaboration collision", `"latestModel":"latest","latestCollaborationMode":{"settings":{"model":"actual"}},"LatestCollaborationMode":false`, "actual", "", ""},
		{"invalid exact model stays invalid", `"latestModel":"latest","latestCollaborationMode":{"settings":{"model":42,"MODEL":"wrong"}}`, "", "", ""},
	} {
		for _, rootPatch := range []bool{false, true} {
			name := tc.name + "/snapshot"
			if rootPatch {
				name = tc.name + "/root-patch"
			}
			t.Run(name, func(t *testing.T) {
				p := &desktopProjection{owner: "owner"}
				projections := map[string]*desktopProjection{"session": p}
				if err := applyDesktopChange(desktopStateEnvelope(t, modelSnapshot(map[string]any{
					"latestModel": "old", "modelProvider": "old-provider", "latestReasoningEffort": "old-effort"}, 1)),
					"observer-client", projections, func(string, protocol.DesktopObservation) {}); err != nil {
					t.Fatal(err)
				}
				state := json.RawMessage(`{"id":"session","hostId":"local","threadRuntimeStatus":{"type":"active"},` + tc.fields + `}`)
				change := map[string]any{"type": "snapshot", "revision": 2, "conversationState": state}
				if rootPatch {
					change = desktopPatchChange(1, 2, map[string]any{"op": "replace", "path": []any{}, "value": state})
				}
				var got protocol.DesktopObservation
				if err := applyDesktopChange(desktopStateEnvelope(t, change), "observer-client", projections,
					func(_ string, o protocol.DesktopObservation) { got = o }); err != nil {
					t.Fatal(err)
				}
				if got.Model != tc.model || got.ModelProvider != tc.provider || got.ReasoningEffort != tc.effort || got.Status != "active" {
					t.Fatalf("non-exact key changed whitelist projection: %+v", got)
				}
			})
		}
	}
}

func TestDesktopModelParentAndLeafPatchesUseExactKeys(t *testing.T) {
	p := &desktopProjection{owner: "owner"}
	projections := map[string]*desktopProjection{"session": p}
	var got protocol.DesktopObservation
	publish := func(_ string, o protocol.DesktopObservation) { got = o }
	if err := applyDesktopChange(desktopStateEnvelope(t, modelSnapshot(map[string]any{"latestModel": "latest"}, 1)), "observer-client", projections, publish); err != nil {
		t.Fatal(err)
	}
	for index, tc := range []struct {
		path  []any
		value json.RawMessage
		model string
	}{
		{[]any{"latestCollaborationMode"}, json.RawMessage(`{"settings":{"model":"actual","MODEL":"wrong"}}`), "actual"},
		{[]any{"latestCollaborationMode", "settings"}, json.RawMessage(`{"model":"actual","MODEL":42}`), "actual"},
		{[]any{"latestCollaborationMode", "SETTINGS"}, json.RawMessage(`{"model":"wrong"}`), "actual"},
		{[]any{"latestCollaborationMode", "settings", "MODEL"}, json.RawMessage(`"wrong"`), "actual"},
		{[]any{"LATESTMODEL"}, json.RawMessage(`"wrong"`), "actual"},
		{[]any{"latestCollaborationMode", "settings"}, json.RawMessage(`{"MODEL":42}`), "latest"},
	} {
		base := uint64(index + 1)
		if err := applyDesktopChange(desktopStateEnvelope(t, desktopPatchChange(base, base+1,
			map[string]any{"op": "replace", "path": tc.path, "value": tc.value})), "observer-client", projections, publish); err != nil {
			t.Fatal(err)
		}
		if got.Model != tc.model || got.Status != "active" {
			t.Fatalf("non-exact patch changed model: %+v", got)
		}
	}
}
