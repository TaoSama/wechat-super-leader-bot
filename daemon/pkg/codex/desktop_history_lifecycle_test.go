package codex

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	historyControlPeerID            = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	historyControlRequestID         = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	historyControlSourceID          = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	historyControlOriginalRequestID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
)

func historyControlStatus(status string) desktopEnvelope {
	return desktopEnvelope{Type: "broadcast", Method: desktopClientStatusChanged, SourceClientID: historyControlPeerID,
		Params: json.RawMessage(`{"clientId":"` + historyControlPeerID + `","clientType":"readonly-observer","status":"` + status + `"}`)}
}

func historyControlDiscovery() desktopEnvelope {
	return desktopEnvelope{Type: desktopClientDiscoveryRequest, RequestID: historyControlRequestID,
		Request: json.RawMessage(`{"type":"request","requestId":"` + historyControlOriginalRequestID + `","sourceClientId":"` + historyControlSourceID + `","method":"thread-owner-discovery","version":1,"timeoutMs":5000,"params":{"conversationId":"session","hostId":"local"}}`)}
}

func TestDesktopHistoryLifecycleDoesNotConsumeOrResetNoise(t *testing.T) {
	stream := desktopHistoryStream{entry: historyUnitEntry(), connection: &desktopConn{clientID: "client"}, owner: "owner", subscribed: true,
		requestID: "pending", method: desktopLoadCompleteHistory, deadline: time.Now().Add(time.Minute), noise: desktopSkipLimit - 1}
	before := stream
	for range 2 * desktopSkipLimit {
		for _, status := range []string{"connected", "disconnected"} {
			if err := stream.handle(historyControlStatus(status)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if !reflect.DeepEqual(stream, before) || stream.entry.ready || stream.entry.err != nil {
		t.Fatal("global lifecycle changed handshake, history state or noise budget")
	}
}

func TestDesktopHistoryOwnerDisconnectExpires(t *testing.T) {
	stream := desktopHistoryStream{entry: historyUnitEntry(), connection: &desktopConn{clientID: "client"}, owner: historyControlPeerID, subscribed: true}
	err := stream.handle(historyControlStatus("disconnected"))
	if err == nil || err.Error() != protocol.HistoryContextExpired || historyFailureReasonOf(err) != historyFailureOwner || stream.noise != 0 {
		t.Fatalf("owner disconnect was not invalidated: %v", err)
	}
}

func TestDesktopHistoryMalformedControlsAndUnknownFloodRemainBounded(t *testing.T) {
	for _, tc := range []struct {
		name   string
		modify func(*desktopEnvelope)
	}{
		{"unknown type", func(m *desktopEnvelope) { m.Type = "unknown" }},
		{"unknown broadcast", func(m *desktopEnvelope) { m.Method = "unknown" }},
		{"status version", func(m *desktopEnvelope) { m.Version = 1 }},
		{"status target", func(m *desktopEnvelope) { m.TargetClientIDs = []string{"client"} }},
		{"status identity", func(m *desktopEnvelope) { m.SourceClientID = historyControlSourceID }},
		{"status unknown field", func(m *desktopEnvelope) {
			m.Params = json.RawMessage(strings.Replace(string(m.Params), `"status":`, `"unknown":true,"status":`, 1))
		}},
		{"status duplicate", func(m *desktopEnvelope) {
			m.Params = json.RawMessage(strings.Replace(string(m.Params), `"status":`, `"status":"connected","status":`, 1))
		}},
		{"status null", func(m *desktopEnvelope) {
			m.Params = json.RawMessage(strings.Replace(string(m.Params), `"connected"`, `null`, 1))
		}},
		{"outer malformed", func(m *desktopEnvelope) { m.historyControlMalformed = true }},
		{"discovery method", func(m *desktopEnvelope) {
			*m = historyControlDiscovery()
			m.Request = json.RawMessage(strings.Replace(string(m.Request), desktopDiscoverOwner, "unknown", 1))
		}},
		{"discovery missing version", func(m *desktopEnvelope) {
			*m = historyControlDiscovery()
			m.Request = json.RawMessage(strings.Replace(string(m.Request), `"version":1,`, "", 1))
		}},
		{"discovery duplicate", func(m *desktopEnvelope) {
			*m = historyControlDiscovery()
			m.Request = json.RawMessage(strings.Replace(string(m.Request), `"version":1`, `"version":1,"version":1`, 1))
		}},
		{"discovery write method", func(m *desktopEnvelope) {
			*m = historyControlDiscovery()
			m.Request = json.RawMessage(strings.Replace(string(m.Request), desktopDiscoverOwner, "thread-follower-start-turn", 1))
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stream := desktopHistoryStream{entry: historyUnitEntry(), connection: &desktopConn{clientID: "client"}, owner: "owner", subscribed: true}
			message := historyControlStatus("connected")
			tc.modify(&message)
			for range desktopSkipLimit {
				if err := stream.handle(message); err != nil {
					t.Fatalf("rejected before budget exhausted: %v", err)
				}
				if err := stream.handle(historyControlStatus("connected")); err != nil {
					t.Fatal(err)
				}
			}
			if err := stream.handle(message); err == nil || historyFailureReasonOf(err) != historyFailureNoise || stream.noise != desktopSkipLimit+1 {
				t.Fatalf("unknown/malformed frame budget bypassed: %v", err)
			}
			if stream.entry.ready || stream.entry.err != nil {
				t.Fatal("noise established or mutated history")
			}
		})
	}
}

func TestDesktopHistoryControlWireShapeRejectsUnknownDuplicateAndNull(t *testing.T) {
	valid := `{"type":"broadcast","method":"client-status-changed","sourceClientId":"` + historyControlPeerID + `","version":0,"params":{"clientId":"` + historyControlPeerID + `","clientType":"readonly","status":"connected"}}`
	for _, wire := range []string{
		strings.Replace(valid, `"version":0`, `"version":0,"unknown":true`, 1),
		strings.Replace(valid, `"version":0`, `"version":0,"version":0`, 1),
		strings.Replace(valid, `"version":0`, `"version":null`, 1),
		strings.Replace(valid, `"version":0,`, "", 1),
	} {
		var message desktopEnvelope
		if err := json.Unmarshal([]byte(wire), &message); err != nil {
			t.Fatal(err)
		}
		if historyControlFrameShape([]byte(wire), message) {
			t.Fatal("malformed outer control escaped noise classification")
		}
	}
}

func TestDesktopHistoryIdleRouterTrafficBeyondNoiseLimitKeepsGeneration(t *testing.T) {
	trafficSent, allowTraffic := make(chan struct{}), make(chan struct{})
	path := desktopFixture(t, func(c *desktopConn) error {
		if err := historyFixtureStart(c, historyTestState(true, historyTestTurn("turn", historyTestItem("item", "agentMessage", "answer")))); err != nil {
			return err
		}
		<-allowTraffic
		for range 2 * desktopSkipLimit {
			if err := c.write(historyControlStatus("connected")); err != nil {
				return err
			}
			if err := c.write(historyControlStatus("disconnected")); err != nil {
				return err
			}
			query := historyControlDiscovery()
			if err := c.write(query); err != nil {
				return err
			}
			response, err := c.read()
			if err != nil {
				return err
			}
			var result struct {
				CanHandle *bool `json:"canHandle"`
			}
			if response.Type != desktopClientDiscoveryResponse || response.RequestID != query.RequestID || json.Unmarshal(response.Response, &result) != nil ||
				result.CanHandle == nil || *result.CanHandle || response.Method != "" || response.SourceClientID != "" || response.TargetClientID != "" || len(response.TargetClientIDs) != 0 {
				return errors.New("history client claimed capability or misbound discovery response")
			}
		}
		close(trafficSent)
		return historyFixtureEnd(c)
	})
	reader := NewDesktopHistoryReader(path)
	t.Cleanup(reader.Reset)
	ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
	defer cancel()
	page, generation, err := reader.ReadHistory(ctx, "session", "", "", 1)
	if err != nil {
		t.Fatal(err)
	}
	close(allowTraffic)
	historyWaitSignal(t, trafficSent)
	current, sameGeneration, err := reader.ReadHistory(ctx, "session", generation, "", 1)
	if err != nil || generation == "" || sameGeneration != generation || !reflect.DeepEqual(current.Items, page.Items) {
		t.Fatalf("legal idle router traffic invalidated history: %v", err)
	}
}
