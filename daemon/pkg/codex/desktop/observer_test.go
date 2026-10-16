package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func desktopStateEnvelope(t *testing.T, change map[string]any) desktopEnvelope {
	t.Helper()
	params, err := json.Marshal(map[string]any{"conversationId": "session", "hostId": "local", "change": change})
	if err != nil {
		t.Fatal(err)
	}
	return desktopEnvelope{Type: "broadcast", Method: desktopStateChanged, Version: 11, SourceClientID: "owner",
		TargetClientIDs: []string{"observer-client"}, Params: params}
}

func desktopSnapshotChange(status string, revision uint64) map[string]any {
	return map[string]any{"type": "snapshot", "revision": revision, "conversationState": map[string]any{
		"id": "session", "hostId": "local", "threadRuntimeStatus": map[string]any{"type": status}}}
}

func desktopPatchChange(base, revision uint64, patches ...map[string]any) map[string]any {
	return map[string]any{"type": "patches", "baseRevision": base, "revision": revision, "patches": patches}
}

func TestDesktopProjectionSnapshotHistoryPatchAndStatus(t *testing.T) {
	projections := map[string]*desktopProjection{"session": {owner: "owner"}}
	var observations []protocol.DesktopObservation
	publish := func(id string, observation protocol.DesktopObservation) {
		if id != "session" {
			t.Errorf("wrong published session: %s", id)
		}
		observations = append(observations, observation)
	}
	changes := []map[string]any{
		desktopSnapshotChange("active", 2),
		desktopPatchChange(2, 3, map[string]any{"op": "add", "path": []any{"turnHistory", "history", "entitiesByKey", "entity", "items", 34}, "value": map[string]any{"text": "private history"}}),
		desktopPatchChange(3, 4, map[string]any{"op": "replace", "path": []any{"threadRuntimeStatus", "type"}, "value": "idle"}),
		desktopPatchChange(4, 5, map[string]any{"op": "replace", "path": []any{"threadRuntimeStatus"}, "value": map[string]any{"type": "future-status"}}),
		desktopPatchChange(5, 6, map[string]any{"op": "add", "path": []any{"threadRuntimeStatus"}, "value": map[string]any{"type": "active"}}),
		desktopPatchChange(6, 7, map[string]any{"op": "remove", "path": []any{"threadRuntimeStatus", "type"}}),
	}
	for _, change := range changes {
		if err := applyDesktopChange(desktopStateEnvelope(t, change), "observer-client", projections, publish); err != nil {
			t.Fatal(err)
		}
	}
	wantStatuses := []string{"active", "active", "idle", "unknown", "active", "unknown"}
	if len(observations) != len(wantStatuses) || projections["session"].revision != 7 {
		t.Fatalf("observations = %+v, projection = %+v", observations, projections["session"])
	}
	for i, observation := range observations {
		if observation.Status != wantStatuses[i] || observation.Availability != "available" || observation.Source != "codex-desktop" {
			t.Errorf("observation %d = %+v", i, observation)
		}
		if _, err := time.Parse(time.RFC3339Nano, observation.ObservedAt); err != nil {
			t.Errorf("observation timestamp: %v", err)
		}
	}
}

func TestDesktopEnvelopeExactIdentityAndRouting(t *testing.T) {
	for _, tc := range []struct {
		name      string
		mutate    func(*desktopEnvelope, map[string]any)
		wantError bool
	}{
		{"wrong owner", func(e *desktopEnvelope, _ map[string]any) { e.SourceClientID = "other-owner" }, true},
		{"wrong target ignored", func(e *desktopEnvelope, _ map[string]any) { e.TargetClientIDs = []string{"other-client"} }, false},
		{"missing target ignored", func(e *desktopEnvelope, _ map[string]any) { e.TargetClientIDs = nil }, false},
		{"wrong version", func(e *desktopEnvelope, _ map[string]any) { e.Version = 10 }, true},
		{"wrong outer id", func(_ *desktopEnvelope, p map[string]any) { p["conversationId"] = "other-session" }, true},
		{"wrong outer host", func(_ *desktopEnvelope, p map[string]any) { p["hostId"] = "remote" }, true},
		{"wrong snapshot id", func(_ *desktopEnvelope, p map[string]any) {
			p["change"].(map[string]any)["conversationState"].(map[string]any)["id"] = "other-session"
		}, true},
		{"wrong snapshot host", func(_ *desktopEnvelope, p map[string]any) {
			p["change"].(map[string]any)["conversationState"].(map[string]any)["hostId"] = "remote"
		}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			envelope := desktopStateEnvelope(t, desktopSnapshotChange("active", 1))
			var params map[string]any
			if err := json.Unmarshal(envelope.Params, &params); err != nil {
				t.Fatal(err)
			}
			tc.mutate(&envelope, params)
			var err error
			envelope.Params, err = json.Marshal(params)
			if err != nil {
				t.Fatal(err)
			}
			published := false
			projections := map[string]*desktopProjection{"session": {owner: "owner"}}
			err = applyDesktopChange(envelope, "observer-client", projections, func(string, protocol.DesktopObservation) { published = true })
			if (err != nil) != tc.wantError || published || projections["session"].initialized {
				t.Fatalf("error = %v, published = %v, projection = %+v", err, published, projections["session"])
			}
		})
	}
}

func TestDesktopProjectionRejectsRevisionGapsAndMalformedPatches(t *testing.T) {
	for _, tc := range []struct {
		name          string
		change        map[string]any
		uninitialized bool
	}{
		{"base revision gap", desktopPatchChange(1, 3), false},
		{"nonincreasing revision", desktopPatchChange(2, 2), false},
		{"patch before snapshot", desktopPatchChange(2, 3), true},
		{"snapshot regression", desktopSnapshotChange("active", 1), false},
		{"missing revision", map[string]any{"type": "snapshot"}, false},
		{"missing base", map[string]any{"type": "patches", "revision": 3}, false},
		{"unsafe revision", desktopSnapshotChange("active", maxDesktopRevision+1), false},
		{"missing path", desktopPatchChange(2, 3, map[string]any{"op": "remove"}), false},
		{"null path", desktopPatchChange(2, 3, map[string]any{"op": "remove", "path": nil}), false},
		{"missing value", desktopPatchChange(2, 3, map[string]any{"op": "replace", "path": []any{"turns", 0}}), false},
		{"bad op", desktopPatchChange(2, 3, map[string]any{"op": "move", "path": []any{"turns", 0}}), false},
		{"bad first path", desktopPatchChange(2, 3, map[string]any{"op": "remove", "path": []any{0}}), false},
		{"bad ignored path", desktopPatchChange(2, 3, map[string]any{"op": "remove", "path": []any{"turns", map[string]any{"invalid": true}}}), false},
		{"negative index", desktopPatchChange(2, 3, map[string]any{"op": "remove", "path": []any{"turns", -1}}), false},
		{"fractional index", desktopPatchChange(2, 3, map[string]any{"op": "remove", "path": []any{"turns", 0.5}}), false},
		{"bad status path", desktopPatchChange(2, 3, map[string]any{"op": "remove", "path": []any{"threadRuntimeStatus", false}}), false},
		{"too deep type path", desktopPatchChange(2, 3, map[string]any{"op": "remove", "path": []any{"threadRuntimeStatus", "type", "extra"}}), false},
		{"identity patch", desktopPatchChange(2, 3, map[string]any{"op": "replace", "path": []any{"id"}, "value": "other"}), false},
		{"root removal", desktopPatchChange(2, 3, map[string]any{"op": "remove", "path": []any{}}), false},
		{"root wrong id", desktopPatchChange(2, 3, map[string]any{"op": "replace", "path": []any{}, "value": map[string]any{"id": "other", "hostId": "local"}}), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			projection := &desktopProjection{owner: "owner", initialized: !tc.uninitialized, revision: 2, status: "active"}
			published := false
			err := applyDesktopChange(desktopStateEnvelope(t, tc.change), "observer-client", map[string]*desktopProjection{"session": projection},
				func(string, protocol.DesktopObservation) { published = true })
			if err == nil || published || projection.revision != 2 {
				t.Fatalf("error = %v, published = %v, revision = %d", err, published, projection.revision)
			}
		})
	}
}

func TestDesktopLargeSnapshotDoesNotRetainHistory(t *testing.T) {
	const historySize = 10 * 1024 * 1024
	change := desktopSnapshotChange("active", 1)
	change["conversationState"].(map[string]any)["turnHistory"] = strings.Repeat("PRIVATE", historySize/len("PRIVATE"))
	envelope := desktopStateEnvelope(t, change)
	if len(envelope.Params) <= 9*1024*1024 {
		t.Fatal("large fixture must exceed 9 MiB")
	}
	projection := &desktopProjection{owner: "owner"}
	var observation protocol.DesktopObservation
	if err := applyDesktopChange(envelope, "observer-client", map[string]*desktopProjection{"session": projection},
		func(_ string, result protocol.DesktopObservation) { observation = result }); err != nil {
		t.Fatal(err)
	}
	// The persistent projection has no reference-bearing history field.
	typ := reflect.TypeOf(*projection)
	for i := range typ.NumField() {
		kind := typ.Field(i).Type.Kind()
		if kind != reflect.String && kind != reflect.Uint64 && kind != reflect.Bool {
			t.Fatalf("projection retains unexpected field %s", typ.Field(i).Name)
		}
	}
	encoded, err := json.Marshal(observation)
	if err != nil {
		t.Fatal(err)
	}
	if observation.Status != "active" || len(encoded) > 256 || strings.Contains(string(encoded), "PRIVATE") {
		t.Fatalf("history leaked into public projection (%d bytes)", len(encoded))
	}
}

func desktopOwnerSubscribe(c *desktopConn) error {
	if err := desktopHandshake(c); err != nil {
		return err
	}
	discovery, err := c.read()
	if err != nil {
		return err
	}
	var params map[string]string
	if err := json.Unmarshal(discovery.Params, &params); err != nil {
		return err
	}
	if discovery.Method != desktopDiscoverOwner || discovery.Version != 1 || discovery.SourceClientID != "observer-client" || params["conversationId"] != "session" || params["hostId"] != "local" {
		return fmt.Errorf("wrong discovery: %+v", discovery)
	}
	if err := desktopReply(c, discovery, "owner", map[string]bool{"supportsUntrustedAppInput": true}); err != nil {
		return err
	}
	return desktopExpectFollow(c, true)
}

func desktopExpectFollow(c *desktopConn, following bool) error {
	message, err := c.read()
	if err != nil {
		return err
	}
	var params struct {
		ConversationID string `json:"conversationId"`
		HostID         string `json:"hostId"`
		Following      bool   `json:"following"`
	}
	if err := json.Unmarshal(message.Params, &params); err != nil {
		return err
	}
	if message.Type != "broadcast" || message.Method != desktopFollowingChanged || message.Version != 1 || message.SourceClientID != "observer-client" || !reflect.DeepEqual(message.TargetClientIDs, []string{"owner"}) || params.ConversationID != "session" || params.HostID != "local" || params.Following != following {
		return fmt.Errorf("incorrect following = %v: %+v", following, message)
	}
	return nil
}

func TestDesktopSnapshotUnsubscribesAndDeduplicates(t *testing.T) {
	change := desktopSnapshotChange("idle", 1)
	state := change["conversationState"].(map[string]any)
	state["latestModel"], state["modelProvider"], state["latestReasoningEffort"] = "desktop-model", "desktop-provider", "ultra"
	state["latestCollaborationMode"] = map[string]any{"settings": map[string]any{"model": nil, "instructions": "PRIVATE INSTRUCTIONS"}}
	const framedHistorySize = 10 * 1024 * 1024
	state["turnHistory"] = strings.Repeat("x", framedHistorySize)
	envelope := desktopStateEnvelope(t, change)
	body, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	path := desktopFixture(t, func(c *desktopConn) error {
		if err := desktopOwnerSubscribe(c); err != nil {
			return err
		}
		if err := desktopFixtureWriteSnapshot(c, body); err != nil {
			return err
		}
		if err := desktopExpectFollow(c, false); err != nil {
			return err
		}
		return desktopExpectClosed(c)
	})
	var observations []protocol.DesktopObservation
	if err := NewDesktopObserver(path).Snapshot(t.Context(), []string{"session", "session"}, func(_ string, o protocol.DesktopObservation) { observations = append(observations, o) }); err != nil {
		t.Fatal(err)
	}
	if len(observations) != 1 || observations[0].Status != "idle" || observations[0].Model != "desktop-model" ||
		observations[0].ModelProvider != "desktop-provider" || observations[0].ReasoningEffort != "ultra" {
		t.Fatalf("observations = %+v", observations)
	}
	wire, err := json.Marshal(observations[0])
	if err != nil || strings.Contains(string(wire), "PRIVATE") || strings.Contains(string(wire), "turnHistory") {
		t.Fatalf("private snapshot data leaked: %s %v", wire, err)
	}
}

func TestDesktopWatchMalformedPatchStopsPublishing(t *testing.T) {
	snapshot := desktopStateEnvelope(t, desktopSnapshotChange("active", 2))
	invalid := desktopStateEnvelope(t, desktopPatchChange(2, 3,
		map[string]any{"op": "replace", "path": []any{"threadRuntimeStatus", "type"}, "value": "idle"},
		map[string]any{"op": "move", "path": []any{"turns", 0}}))
	path := desktopWatchFixture(t, map[string]string{"session": "owner"}, func(c *desktopConn, _ string) error {
		if err := c.write(snapshot); err != nil {
			return err
		}
		if err := c.write(invalid); err != nil {
			return err
		}
		if err := desktopExpectFollow(c, false); err != nil {
			return err
		}
		return desktopExpectClosed(c)
	})
	var observations []protocol.DesktopObservation
	observer := NewDesktopObserver(path)
	observer.watchWindow = desktopTestOwnerTimeout
	err := observer.Watch(context.Background(), []string{"session"}, func(_ string, o protocol.DesktopObservation) {
		observations = append(observations, o)
	})
	if err != nil || len(observations) < 3 || observations[0].Availability != "unavailable" || observations[1].Status != "active" || observations[len(observations)-1].Availability != "unavailable" {
		t.Fatalf("invalid patch should stop before publishing: %v, %+v", err, observations)
	}
	for _, observation := range observations {
		if observation.Availability == "available" && observation.Status != "active" {
			t.Fatalf("partially applied malformed patch was published: %+v", observation)
		}
	}
}

func TestDesktopMissingOwnerErrorWithoutMethod(t *testing.T) {
	path := desktopFixture(t, func(c *desktopConn) error {
		if err := desktopHandshake(c); err != nil {
			return err
		}
		request, err := c.read()
		if err != nil {
			return err
		}
		// Native router errors intentionally omit method and handledByClientId.
		if err := c.write(desktopEnvelope{Type: "response", RequestID: request.RequestID, ResultType: "error"}); err != nil {
			return err
		}
		return desktopExpectClosed(c)
	})
	var observations []protocol.DesktopObservation
	if err := NewDesktopObserver(path).Snapshot(context.Background(), []string{"session"}, func(_ string, o protocol.DesktopObservation) { observations = append(observations, o) }); err != nil {
		t.Fatal(err)
	}
	if len(observations) != 1 || observations[0].Status != "unknown" || observations[0].Availability != "unavailable" || observations[0].ObservedAt != "" {
		t.Fatalf("observations = %+v", observations)
	}
}

func TestDesktopWatchCancellationClosesConnection(t *testing.T) {
	envelope := desktopStateEnvelope(t, desktopSnapshotChange("active", 1))
	closed := make(chan struct{})
	path := desktopWatchFixture(t, map[string]string{"session": "owner"}, func(c *desktopConn, _ string) error {
		defer close(closed)
		if err := c.write(envelope); err != nil {
			return err
		}
		// Cancellation may close the socket before best-effort unsubscribe.
		if err := desktopExpectFollow(c, false); err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		return desktopExpectClosed(c)
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	observed := make(chan protocol.DesktopObservation, 1)
	done := make(chan error, 1)
	go func() {
		done <- NewDesktopObserver(path).Watch(ctx, []string{"session"}, func(_ string, o protocol.DesktopObservation) {
			if o.Availability == "available" {
				observed <- o
			}
		})
	}()
	select {
	case observation := <-observed:
		if observation.Status != "active" {
			t.Errorf("observation = %+v", observation)
		}
	case <-time.After(desktopTestTimeout):
		t.Fatal("watch did not publish snapshot")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(desktopTestTimeout):
		t.Fatal("canceled watcher goroutine did not stop")
	}
	select {
	case <-closed:
	case <-time.After(desktopTestTimeout):
		t.Fatal("canceled watch retained the connection")
	}
}
