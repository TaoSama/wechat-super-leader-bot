package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestDesktopSubscriptionObservationVersions(t *testing.T) {
	for _, version := range []int{11, 13} {
		t.Run(fmt.Sprintf("version-%d", version), func(t *testing.T) {
			path, waitIdle := isolationFixture(t, func(c *desktopConn, id string) error {
				changes := []map[string]any{
					{"type": "snapshot", "revision": 1, "conversationState": map[string]any{
						"id": id, "hostId": "local", "threadRuntimeStatus": map[string]string{"type": "active"}}},
					desktopPatchChange(1, 2, map[string]any{"op": "replace", "path": []any{"threadRuntimeStatus", "type"}, "value": "idle"}),
				}
				for _, change := range changes {
					message, err := desktopAnySessionEnvelope(id, "owner-"+id, change)
					if err != nil {
						return err
					}
					message.Version, message.TargetClientIDs = version, []string{c.clientID}
					if err := c.write(message); err != nil {
						return err
					}
				}
				return isolationUnfollowOrClose(c, id)
			})
			ctx, cancel := context.WithTimeout(context.Background(), isolationWait)
			defer cancel()
			var statuses []string
			err := NewDesktopObserver(path).Watch(ctx, []string{"session"}, func(id string, observation protocol.DesktopObservation) {
				if observation.Availability != "available" {
					return
				}
				if id != "session" || observation.OwnerID != "owner-session" || observation.Revision != uint64(len(statuses)+1) {
					t.Error("observation lost its target, owner or revision")
				}
				statuses = append(statuses, observation.Status)
				if observation.Revision == 2 {
					cancel()
				}
			})
			waitIdle()
			if !errors.Is(err, context.Canceled) || !reflect.DeepEqual(statuses, []string{"active", "idle"}) {
				t.Fatalf("version %d subscription: error=%v statuses=%v", version, err, statuses)
			}
		})
	}
}

func TestDesktopObservationVersion13PreservesValidation(t *testing.T) {
	snapshotWithoutRevision := desktopSnapshotChange("active", 3)
	delete(snapshotWithoutRevision, "revision")
	for _, tc := range []struct {
		name      string
		version   int
		change    map[string]any
		mutate    func(*desktopEnvelope)
		wantError bool
	}{
		{"unsupported-zero", 0, desktopSnapshotChange("active", 3), nil, true},
		{"unsupported-old", 10, desktopSnapshotChange("active", 3), nil, true},
		{"unsupported-intermediate", 12, desktopSnapshotChange("active", 3), nil, true},
		{"unsupported-future", 14, desktopSnapshotChange("active", 3), nil, true},
		{"wrong-owner", 13, desktopSnapshotChange("active", 3), func(e *desktopEnvelope) { e.SourceClientID = "other-owner" }, true},
		{"unrelated-recipient", 13, desktopSnapshotChange("active", 3), func(e *desktopEnvelope) { e.TargetClientIDs = []string{"other-client"} }, false},
		{"wrong-outer-host", 13, desktopSnapshotChange("idle", 3), func(e *desktopEnvelope) {
			e.Params = []byte(`{"conversationId":"session","hostId":"remote","change":{"type":"snapshot","revision":3,"conversationState":{"id":"session","hostId":"local","threadRuntimeStatus":{"type":"idle"}}}}`)
		}, true},
		{"wrong-snapshot-target", 13, map[string]any{"type": "snapshot", "revision": 3, "conversationState": map[string]string{"id": "other", "hostId": "local"}}, nil, true},
		{"wrong-snapshot-host", 13, map[string]any{"type": "snapshot", "revision": 3, "conversationState": map[string]string{"id": "session", "hostId": "remote"}}, nil, true},
		{"missing-revision", 13, snapshotWithoutRevision, nil, true},
		{"snapshot-regression", 13, desktopSnapshotChange("idle", 1), nil, true},
		{"patch-revision-gap", 13, desktopPatchChange(1, 3), nil, true},
		{"late-identity-patch", 13, desktopPatchChange(2, 3,
			map[string]any{"op": "replace", "path": []any{"threadRuntimeStatus", "type"}, "value": "idle"},
			map[string]any{"op": "replace", "path": []any{"id"}, "value": "other"}), nil, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			message := desktopStateEnvelope(t, tc.change)
			message.Version = tc.version
			if tc.mutate != nil {
				tc.mutate(&message)
			}
			projection := &desktopProjection{owner: "owner", initialized: true, revision: 2, status: "active"}
			before, published := *projection, false
			err := applyDesktopChange(message, "observer-client", map[string]*desktopProjection{"session": projection}, func(string, protocol.DesktopObservation) {
				published = true
			})
			if (err != nil) != tc.wantError || published || !reflect.DeepEqual(*projection, before) {
				t.Fatalf("validation changed: error=%v published=%t state=%+v", err, published, projection)
			}
		})
	}
}

func TestDesktopObservationVersion13PatchTargetRouting(t *testing.T) {
	for _, target := range []string{"other", "session"} {
		t.Run(target, func(t *testing.T) {
			change := desktopPatchChange(2, 3, map[string]any{
				"op": "replace", "path": []any{"threadRuntimeStatus", "type"}, "value": "idle"})
			message := desktopStateEnvelope(t, change)
			message.Version = 13
			var err error
			message.Params, err = json.Marshal(map[string]any{"conversationId": target, "hostId": "local", "change": change})
			if err != nil {
				t.Fatal(err)
			}
			projection := &desktopProjection{owner: "owner", initialized: true, revision: 2, status: "active"}
			before := *projection
			var observations []protocol.DesktopObservation
			err = applyDesktopChange(message, "observer-client", map[string]*desktopProjection{"session": projection}, func(id string, observation protocol.DesktopObservation) {
				if id != "session" {
					t.Errorf("published unexpected target: %s", id)
				}
				observations = append(observations, observation)
			})
			if target == "other" {
				if err == nil || len(observations) != 0 || !reflect.DeepEqual(*projection, before) {
					t.Fatalf("invalid target changed state: error=%v observations=%+v state=%+v", err, observations, projection)
				}
				return
			}
			if err != nil || len(observations) != 1 || observations[0].Status != "idle" || observations[0].Revision != 3 || observations[0].Availability != "available" || projection.status != "idle" || projection.revision != 3 {
				t.Fatalf("valid target patch failed: error=%v observations=%+v state=%+v", err, observations, projection)
			}
		})
	}
}
