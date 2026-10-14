package desktop

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestDesktopHistoryFailureLogsOnlyAllowlistedReasons(t *testing.T) {
	secret := "private transcript /socket owner context cursor\nINJECTED"
	for _, err := range []error{errors.New(secret), historyFailure(secret, historyFailureReason(secret)),
		fmt.Errorf("wrapped %s: %w", secret, historyFailure(secret, historyFailurePatch))} {
		reason := historyFailureReasonOf(err)
		line := historyFailureLogLine(reason, true, true, true, false)
		if strings.Contains(line, secret) || strings.Contains(line, "INJECTED") || strings.ContainsAny(line, "\r\n") {
			t.Fatal("diagnostic included arbitrary input")
		}
		if reason != historyFailureUnknown && reason != historyFailurePatch {
			t.Fatalf("unexpected reason %q", reason)
		}
	}
	entry := historyUnitEntry()
	entry.delivered = true
	entry.failReason(secret, historyFailureTransport)
	if entry.err == nil || entry.err.Error() != protocol.HistoryContextExpired {
		t.Fatal("delivered context no longer preserves public invalidation contract")
	}
	entry = historyUnitEntry()
	entry.failReason(protocol.HistoryUnavailable, historyFailureTransport)
	if entry.err == nil || entry.err.Error() != protocol.HistoryUnavailable {
		t.Fatal("pre-delivery error contract changed")
	}
}

func TestDesktopHistoryNoiseDiagnosticContainsOnlyCounts(t *testing.T) {
	noise := desktopHistoryNoise{}
	for _, message := range []desktopEnvelope{
		{Type: "broadcast", Method: "client-status-changed"},
		{Type: "client-discovery-request"},
		{Type: "broadcast", Method: desktopStateChanged},
		{Type: "broadcast", Method: desktopFollowingChanged},
		{Type: "response", Method: "secret"},
		{Type: "secret", Method: "private\nINJECTED", SourceClientID: "private-owner"},
	} {
		noise.observe(message)
	}
	if noise != (desktopHistoryNoise{clientStatus: 1, discoveryRequest: 1, state: 1, following: 1, response: 1, other: 1}) {
		t.Fatal("fixed noise classification changed")
	}
	line := noise.logLine(false, true)
	if strings.Contains(line, "secret") || strings.Contains(line, "private") || strings.ContainsAny(line, "\r\n") {
		t.Fatal("noise diagnostic included arbitrary data")
	}
}

func TestDesktopHistoryFailureDistinguishesRejectedStateChanges(t *testing.T) {
	for _, tc := range []struct {
		name   string
		reason historyFailureReason
		change func(map[string]any) map[string]any
	}{
		{"revision", historyFailureRevision, func(state map[string]any) map[string]any {
			return map[string]any{"type": "snapshot", "revision": 0, "conversationState": state}
		}},
		{"same revision", historyFailureSnapshot, func(state map[string]any) map[string]any {
			state["title"] = "changed"
			return map[string]any{"type": "snapshot", "revision": 1, "conversationState": state}
		}},
		{"patch gap", historyFailurePatch, func(_ map[string]any) map[string]any { return desktopPatchChange(0, 2) }},
		{"generation", historyFailureGeneration, func(_ map[string]any) map[string]any {
			return desktopPatchChange(1, 2, map[string]any{"op": "replace", "path": []any{"turnHistory", "history", "generation"}, "value": "new"})
		}},
		{"prefix", historyFailurePrefix, func(_ map[string]any) map[string]any {
			return desktopPatchChange(1, 2, map[string]any{"op": "replace", "path": []any{"turnHistory", "history", "entitiesByKey", "k", "items"}, "value": []any{historyTestItem("other", "agentMessage", "untrusted")}})
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			entry := historyUnitEntry()
			state := historyTestState(true, historyTestTurn("turn", historyTestItem("item", "agentMessage", "private")))
			if err := historyUnitChange(t, entry, map[string]any{"type": "snapshot", "revision": 1, "conversationState": state}); err != nil {
				t.Fatal(err)
			}
			err := historyUnitChange(t, entry, tc.change(state))
			if err == nil || err.Error() != protocol.HistoryContextExpired || historyFailureReasonOf(err) != tc.reason {
				t.Fatalf("expected unchanged public error and reason %s, got %v", tc.reason, err)
			}
			if entry.revision != 1 || entry.view.items[0].ID != "item" {
				t.Fatal("diagnostic changed rejection or partially committed state")
			}
		})
	}
}

func TestDesktopHistoryFailureDistinguishesOwnerFollowingVersionAndNoise(t *testing.T) {
	for _, tc := range []struct {
		name   string
		reason historyFailureReason
		modify func(*desktopHistoryStream, *desktopEnvelope)
	}{
		{"owner", historyFailureOwner, func(_ *desktopHistoryStream, message *desktopEnvelope) { message.SourceClientID = "wrong" }},
		{"following", historyFailureFollowing, func(_ *desktopHistoryStream, message *desktopEnvelope) {
			message.Method, message.Version = desktopFollowingChanged, 1
			message.Params = json.RawMessage(`{"conversationId":"session","hostId":"local","following":false}`)
		}},
		{"version", historyFailureVersion, func(_ *desktopHistoryStream, message *desktopEnvelope) { message.Version = 12 }},
		{"noise", historyFailureNoise, func(stream *desktopHistoryStream, message *desktopEnvelope) {
			stream.noise = desktopSkipLimit
			message.TargetClientIDs = []string{"other"}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stream := desktopHistoryStream{entry: historyUnitEntry(), connection: &desktopConn{clientID: "client"}, owner: "owner", subscribed: true, deadline: time.Now().Add(time.Second)}
			message := desktopEnvelope{Type: "broadcast", Method: desktopStateChanged, Version: 11, SourceClientID: "owner", TargetClientIDs: []string{"client"}}
			tc.modify(&stream, &message)
			if err := stream.handle(message); err == nil || historyFailureReasonOf(err) != tc.reason {
				t.Fatalf("rejection reason=%s error=%v", tc.reason, err)
			}
		})
	}
}
