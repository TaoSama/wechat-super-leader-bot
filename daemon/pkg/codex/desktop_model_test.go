package codex

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func modelSnapshot(fields map[string]any, revision uint64) map[string]any {
	change := desktopSnapshotChange("active", revision)
	state := change["conversationState"].(map[string]any)
	for key, value := range fields {
		state[key] = value
	}
	return change
}

func TestDesktopModelSnapshotNullishOverrideAndInvalidParents(t *testing.T) {
	for _, tc := range []struct {
		name string
		mode any
		want string
	}{
		{"missing", nil, "latest"},
		{"missing settings", map[string]any{}, "latest"},
		{"null settings", map[string]any{"settings": nil}, "latest"},
		{"missing model", map[string]any{"settings": map[string]any{}}, "latest"},
		{"null model", map[string]any{"settings": map[string]any{"model": nil}}, "latest"},
		{"override", map[string]any{"settings": map[string]any{"model": "override"}}, "override"},
		{"bad mode", true, ""},
		{"array mode", []any{}, ""},
		{"bad settings", map[string]any{"settings": false}, ""},
		{"array settings", map[string]any{"settings": []any{}}, ""},
		{"bad model", map[string]any{"settings": map[string]any{"model": 42}}, ""},
		{"empty model", map[string]any{"settings": map[string]any{"model": ""}}, ""},
		{"whitespace model", map[string]any{"settings": map[string]any{"model": " invalid"}}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			projection := &desktopProjection{owner: "owner"}
			fields := map[string]any{"latestModel": "latest", "modelProvider": "provider", "latestReasoningEffort": "ultra"}
			if tc.name != "missing" {
				fields["latestCollaborationMode"] = tc.mode
			}
			var got protocol.DesktopObservation
			if err := applyDesktopChange(desktopStateEnvelope(t, modelSnapshot(fields, 1)), "observer-client",
				map[string]*desktopProjection{"session": projection}, func(_ string, o protocol.DesktopObservation) { got = o }); err != nil {
				t.Fatal(err)
			}
			if got.Model != tc.want || got.Status != "active" || got.Availability != "available" {
				t.Fatalf("incorrect independent model projection: %+v", got)
			}
			if tc.want == "" && (got.ModelProvider != "" || got.ReasoningEffort != "") ||
				tc.want != "" && (got.ModelProvider != "provider" || got.ReasoningEffort != "ultra") {
				t.Fatalf("incorrect model group: %+v", got)
			}
			// A new snapshot never retains fields omitted by the new state.
			if err := applyDesktopChange(desktopStateEnvelope(t, desktopSnapshotChange("idle", 2)), "observer-client",
				map[string]*desktopProjection{"session": projection}, func(_ string, o protocol.DesktopObservation) { got = o }); err != nil {
				t.Fatal(err)
			}
			if got.Model != "" || got.ModelProvider != "" || got.ReasoningEffort != "" || got.Status != "idle" {
				t.Fatalf("new snapshot retained old metadata: %+v", got)
			}
		})
	}
}

func TestDesktopModelMetadataValidationAndWireOmission(t *testing.T) {
	unicodeBoundary := strings.Repeat("界", maxDesktopModelMetadataBytes/len("界")) + "x"
	for _, tc := range []struct {
		name string
		raw  json.RawMessage
		want bool
	}{
		{"ascii boundary", json.RawMessage(`"` + strings.Repeat("x", maxDesktopModelMetadataBytes) + `"`), true},
		{"unicode boundary", json.RawMessage(`"` + unicodeBoundary + `"`), true},
		{"unicode too long", json.RawMessage(`"` + unicodeBoundary + `x"`), false},
		{"ascii too long", json.RawMessage(`"` + strings.Repeat("x", maxDesktopModelMetadataBytes+1) + `"`), false},
		{"empty", json.RawMessage(`""`), false},
		{"leading space", json.RawMessage(`" model"`), false},
		{"trailing unicode space", json.RawMessage(`"model\u3000"`), false},
		{"leading bom", json.RawMessage(`"\ufeffmodel"`), false},
		{"trailing bom", json.RawMessage(`"model\ufeff"`), false},
		{"internal bom", json.RawMessage(`"model\ufeffname"`), true},
		{"newline", json.RawMessage(`"model\nname"`), false},
		{"null byte", json.RawMessage(`"model\u0000name"`), false},
		{"del", json.RawMessage(`"model\u007fname"`), false},
		{"c1 control", json.RawMessage(`"model\u0085name"`), false},
		{"replacement", json.RawMessage(`"model\ufffdname"`), false},
		{"high surrogate", json.RawMessage(`"model\ud800name"`), false},
		{"low surrogate", json.RawMessage(`"model\udfffname"`), false},
		{"paired surrogate", json.RawMessage(`"model\ud83d\ude00"`), true},
		{"invalid utf8", json.RawMessage{'"', 0xff, '"'}, false},
		{"number", json.RawMessage(`42`), false},
		{"object", json.RawMessage(`{}`), false},
		{"array", json.RawMessage(`[]`), false},
		{"null", json.RawMessage(`null`), false},
		{"missing", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			value := desktopModelString(tc.raw)
			if (value != "") != tc.want {
				t.Fatalf("validation mismatch: valid=%v", value != "")
			}
			// The same validation applies to each optional member, independently.
			p := &desktopProjection{latestModel: "model", collaborationNullish: true,
				modelProvider: value, reasoningEffort: value}
			model, provider, effort := p.modelMetadata()
			wire, err := json.Marshal(protocol.DesktopObservation{Model: model, ModelProvider: provider, ReasoningEffort: effort})
			if err != nil {
				t.Fatal(err)
			}
			if !tc.want && (strings.Contains(string(wire), "modelProvider") || strings.Contains(string(wire), "reasoningEffort")) {
				t.Fatalf("invalid optional fields reached wire: %s", wire)
			}
		})
	}
}

func TestDesktopModelPatchesRebuildParentsAndClearInvalidValues(t *testing.T) {
	p := &desktopProjection{owner: "owner"}
	projections := map[string]*desktopProjection{"session": p}
	var got protocol.DesktopObservation
	publish := func(_ string, o protocol.DesktopObservation) { got = o }
	if err := applyDesktopChange(desktopStateEnvelope(t, modelSnapshot(map[string]any{
		"latestModel": "latest", "modelProvider": "provider", "latestReasoningEffort": "high"}, 1)), "observer-client", projections, publish); err != nil {
		t.Fatal(err)
	}
	for index, tc := range []struct {
		name, op                string
		path                    []any
		value                   any
		model, provider, effort string
	}{
		{"override leaf", "add", []any{"latestCollaborationMode", "settings", "model"}, "override", "override", "provider", "high"},
		{"latest behind override", "replace", []any{"latestModel"}, "new-latest", "override", "provider", "high"},
		{"effort leaf", "replace", []any{"latestReasoningEffort"}, "ultra", "override", "provider", "ultra"},
		{"null override", "replace", []any{"latestCollaborationMode", "settings", "model"}, nil, "new-latest", "provider", "ultra"},
		{"settings parent", "replace", []any{"latestCollaborationMode", "settings"}, map[string]any{"model": "parent-model"}, "parent-model", "provider", "ultra"},
		{"remove settings", "remove", []any{"latestCollaborationMode", "settings"}, nil, "new-latest", "provider", "ultra"},
		{"mode parent", "replace", []any{"latestCollaborationMode"}, map[string]any{"settings": map[string]any{"model": "mode-model"}}, "mode-model", "provider", "ultra"},
		{"unrelated instructions", "replace", []any{"latestCollaborationMode", "settings", "instructions"}, "PRIVATE", "mode-model", "provider", "ultra"},
		{"bad mode parent", "replace", []any{"latestCollaborationMode"}, false, "", "", ""},
		{"empty settings parent", "replace", []any{"latestCollaborationMode", "settings"}, map[string]any{}, "new-latest", "provider", "ultra"},
		{"bad settings parent", "replace", []any{"latestCollaborationMode", "settings"}, []any{}, "", "", ""},
		{"remove mode", "remove", []any{"latestCollaborationMode"}, nil, "new-latest", "provider", "ultra"},
		{"bad override leaf", "replace", []any{"latestCollaborationMode", "settings", "model"}, 42, "", "", ""},
		{"remove override leaf", "remove", []any{"latestCollaborationMode", "settings", "model"}, nil, "new-latest", "provider", "ultra"},
		{"bad latest", "replace", []any{"latestModel"}, map[string]any{}, "", "", ""},
		{"latest restored", "replace", []any{"latestModel"}, "restored", "restored", "provider", "ultra"},
		{"bad provider", "replace", []any{"modelProvider"}, "bad\nprovider", "restored", "", "ultra"},
		{"remove effort", "remove", []any{"latestReasoningEffort"}, nil, "restored", "", ""},
		{"remove latest", "remove", []any{"latestModel"}, nil, "", "", ""},
		{"latest restored again", "replace", []any{"latestModel"}, "restored", "restored", "", ""},
		{"numeric mode container", "add", []any{"latestCollaborationMode", 0}, "invalid", "", "", ""},
		{"null mode restores fallback", "replace", []any{"latestCollaborationMode"}, nil, "restored", "", ""},
		{"numeric settings container", "add", []any{"latestCollaborationMode", "settings", 0}, "invalid", "", "", ""},
		{"null settings restores fallback", "replace", []any{"latestCollaborationMode", "settings"}, nil, "restored", "", ""},
		{"bad model descendant", "replace", []any{"latestCollaborationMode", "settings", "model", "nested"}, "invalid", "", "", ""},
		{"remove override restores fallback", "remove", []any{"latestCollaborationMode", "settings", "model"}, nil, "restored", "", ""},
		{"bad latest descendant", "replace", []any{"latestModel", "nested"}, "invalid", "", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			patch := map[string]any{"op": tc.op, "path": tc.path}
			if tc.op != "remove" {
				patch["value"] = tc.value
			}
			base := uint64(index + 1)
			if err := applyDesktopChange(desktopStateEnvelope(t, desktopPatchChange(base, base+1, patch)), "observer-client", projections, publish); err != nil {
				t.Fatal(err)
			}
			if got.Model != tc.model || got.ModelProvider != tc.provider || got.ReasoningEffort != tc.effort || got.Status != "active" || got.Availability != "available" {
				t.Fatalf("incorrect patch projection: %+v", got)
			}
		})
	}
	// Whole-root replacement also resets all metadata, without changing identity.
	root := map[string]any{"id": "session", "hostId": "local", "threadRuntimeStatus": map[string]any{"type": "idle"}}
	if err := applyDesktopChange(desktopStateEnvelope(t, desktopPatchChange(p.revision, p.revision+1,
		map[string]any{"op": "replace", "path": []any{}, "value": root})), "observer-client", projections, publish); err != nil {
		t.Fatal(err)
	}
	if got.Model != "" || got.ModelProvider != "" || got.ReasoningEffort != "" || got.Status != "idle" {
		t.Fatalf("root did not reset metadata: %+v", got)
	}
}

func TestDesktopModelIdentityAndRevisionFailuresDoNotPublish(t *testing.T) {
	for _, kind := range []string{"owner", "session", "revision"} {
		t.Run(kind, func(t *testing.T) {
			p := &desktopProjection{owner: "owner"}
			projections := map[string]*desktopProjection{"session": p}
			if err := applyDesktopChange(desktopStateEnvelope(t, modelSnapshot(map[string]any{"latestModel": "old"}, 1)), "observer-client", projections, func(string, protocol.DesktopObservation) {}); err != nil {
				t.Fatal(err)
			}
			before := *p
			change := desktopPatchChange(1, 2, map[string]any{"op": "replace", "path": []any{"latestModel"}, "value": "new"})
			if kind == "revision" {
				change["baseRevision"] = 0
			}
			e := desktopStateEnvelope(t, change)
			if kind == "owner" {
				e.SourceClientID = "other"
			}
			if kind == "session" {
				e = desktopStateEnvelope(t, modelSnapshot(map[string]any{"id": "other", "latestModel": "new"}, 2))
			}
			published := false
			if err := applyDesktopChange(e, "observer-client", projections, func(string, protocol.DesktopObservation) { published = true }); err == nil || published || !reflect.DeepEqual(before, *p) {
				t.Fatalf("identity failure changed projection: err=%v published=%v", err, published)
			}
		})
	}
}

func TestDesktopModelWatchFramedPatchesPreserveValidStatus(t *testing.T) {
	changes := []map[string]any{
		modelSnapshot(map[string]any{"latestModel": "first", "modelProvider": "provider", "latestReasoningEffort": "high"}, 1),
		desktopPatchChange(1, 2, map[string]any{"op": "replace", "path": []any{"latestModel"}, "value": json.RawMessage(`"bad\ud800model"`)}),
		desktopPatchChange(2, 3, map[string]any{"op": "replace", "path": []any{"latestModel"}, "value": "restored"}),
	}
	envelopes := make([]desktopEnvelope, 0, len(changes))
	for _, change := range changes {
		envelopes = append(envelopes, desktopStateEnvelope(t, change))
	}
	path := desktopFixture(t, func(c *desktopConn) error {
		if err := desktopOwnerSubscribe(c); err != nil {
			return err
		}
		for _, envelope := range envelopes {
			if err := c.write(envelope); err != nil {
				return err
			}
		}
		return desktopExpectClosed(c)
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var observations []protocol.DesktopObservation
	err := NewDesktopObserver(path).Watch(ctx, []string{"session"}, func(_ string, o protocol.DesktopObservation) {
		if o.Availability != "available" {
			return
		}
		observations = append(observations, o)
		if len(observations) == len(envelopes) {
			cancel()
		}
	})
	if !errors.Is(err, context.Canceled) || len(observations) != len(envelopes) {
		t.Fatalf("watch failed to apply framed model patches: err=%v observations=%d", err, len(observations))
	}
	for i, expected := range []string{"first", "", "restored"} {
		o := observations[i]
		if o.Model != expected || o.Status != "active" || o.Availability != "available" || o.Source != "codex-desktop" || o.OwnerID != "owner" || o.Revision != uint64(i+1) {
			t.Fatalf("invalid framed projection: %+v", o)
		}
		if expected == "" && (o.ModelProvider != "" || o.ReasoningEffort != "") {
			t.Fatalf("unknown model exported residual metadata: %+v", o)
		}
	}
}
