package codex

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const historyPreSubscriptionClientID = "history-client"
const historyPreSubscriptionOwnerID = "owner"

func historyPreSubscriptionBroadcast(method, owner string, following bool) (desktopEnvelope, error) {
	params := map[string]any{"conversationId": "session", "hostId": "local"}
	version := 1
	if method == desktopStateChanged {
		version = 11
		params["change"] = map[string]any{"type": "snapshot", "revision": 1,
			"conversationState": historyTestState(false, historyTestTurn("untrusted-turn", historyTestItem("untrusted-item", "agentMessage", "not subscribed")))}
	} else {
		params["following"] = following
	}
	encoded, err := json.Marshal(params)
	if err != nil {
		return desktopEnvelope{}, err
	}
	return desktopEnvelope{Type: "broadcast", Method: method, Version: version, SourceClientID: owner,
		TargetClientIDs: []string{historyPreSubscriptionClientID}, Params: encoded}, nil
}

func TestDesktopHistoryPreSubscriptionBroadcastsPreserveHandshake(t *testing.T) {
	for _, stage := range []struct{ name, method, owner string }{
		{"discovery", desktopDiscoverOwner, ""},
		{"settings", desktopReadSettings, historyPreSubscriptionOwnerID},
	} {
		for _, event := range []struct {
			name, method string
			following    bool
		}{
			{"state", desktopStateChanged, false},
			{"following-false", desktopFollowingChanged, false},
			{"following-true", desktopFollowingChanged, true},
		} {
			t.Run(stage.name+"/"+event.name, func(t *testing.T) {
				entry := historyUnitEntry()
				changed := entry.changed
				stream := desktopHistoryStream{entry: entry, connection: &desktopConn{clientID: historyPreSubscriptionClientID},
					owner: stage.owner, requestID: "pending-request", method: stage.method, deadline: time.Now().Add(time.Minute)}
				before := stream
				owner := stage.owner
				if owner == "" {
					owner = "unconfirmed-owner"
				}
				message, err := historyPreSubscriptionBroadcast(event.method, owner, event.following)
				if err != nil {
					t.Fatal(err)
				}
				if err := stream.handle(message); err != nil {
					t.Fatalf("pre-subscription broadcast invalidated handshake: %v", err)
				}
				if stream.noise != before.noise+1 {
					t.Fatalf("broadcast not counted as noise: %d", stream.noise)
				}
				stream.noise = before.noise
				stream.noiseKinds = before.noiseKinds
				if !reflect.DeepEqual(stream, before) || entry.ready || entry.delivered || entry.revision != 0 || entry.changed != changed ||
					len(entry.raw) != 0 || len(entry.view.items) != 0 || len(entry.order) != 0 || len(entry.cursors) != 0 || entry.loadRequested || entry.err != nil {
					t.Fatal("unsubscribed broadcast changed request, deadline, owner or history state")
				}
			})
		}
	}
}

func TestDesktopHistoryPreSubscriptionNoiseRemainsBounded(t *testing.T) {
	stream := desktopHistoryStream{entry: historyUnitEntry(), connection: &desktopConn{clientID: historyPreSubscriptionClientID},
		requestID: "pending-request", method: desktopDiscoverOwner, deadline: time.Now().Add(time.Minute)}
	message, err := historyPreSubscriptionBroadcast(desktopFollowingChanged, "unconfirmed-owner", false)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < desktopSkipLimit; i++ {
		if err := stream.handle(message); err != nil {
			t.Fatalf("noise %d rejected before budget exhausted: %v", i+1, err)
		}
	}
	if err := stream.handle(message); err == nil || err.Error() != protocol.HistoryFailed || stream.noise != desktopSkipLimit+1 {
		t.Fatalf("noise budget bypassed: noise=%d err=%v", stream.noise, err)
	}
}

func TestDesktopHistorySubscribedBroadcastsStillExpire(t *testing.T) {
	for _, event := range []struct {
		name, method, owner string
	}{
		{"wrong-owner-state", desktopStateChanged, "other-owner"},
		{"wrong-owner-following", desktopFollowingChanged, "other-owner"},
		{"following-false", desktopFollowingChanged, historyPreSubscriptionOwnerID},
	} {
		t.Run(event.name, func(t *testing.T) {
			entry := historyUnitEntry()
			stream := desktopHistoryStream{entry: entry, connection: &desktopConn{clientID: historyPreSubscriptionClientID},
				owner: historyPreSubscriptionOwnerID, subscribed: true}
			message, err := historyPreSubscriptionBroadcast(event.method, event.owner, false)
			if err != nil {
				t.Fatal(err)
			}
			if err := stream.handle(message); err == nil || err.Error() != protocol.HistoryContextExpired {
				t.Fatalf("subscribed invalidation was ignored: %v", err)
			}
			if stream.noise != 0 || entry.ready {
				t.Fatal("invalid subscribed broadcast became noise or established history")
			}
		})
	}
}

func historyPreSubscriptionRequest(c *desktopConn, method, owner string) (desktopEnvelope, error) {
	request, err := c.read()
	if err != nil {
		return request, err
	}
	var params map[string]any
	if json.Unmarshal(request.Params, &params) != nil || request.Method != method || request.Version != 1 || request.RequestID == "" ||
		request.TargetClientID != owner || params["conversationId"] != "session" ||
		(method == desktopDiscoverOwner && params["hostId"] != "local") {
		return request, fmt.Errorf("unexpected history handshake request: %s", request.Method)
	}
	return request, nil
}

func TestDesktopHistoryPreSubscriptionBroadcastsFirstPage(t *testing.T) {
	path := desktopFixture(t, func(c *desktopConn) error {
		initialize, err := c.read()
		if err != nil {
			return err
		}
		var params map[string]any
		if json.Unmarshal(initialize.Params, &params) != nil || initialize.Method != desktopInitialize || params["clientType"] != desktopHistoryClient {
			return fmt.Errorf("unexpected initialize request: %s", initialize.Method)
		}
		if err := historyFixtureReply(c, initialize, historyPreSubscriptionClientID, map[string]any{"clientId": historyPreSubscriptionClientID}); err != nil {
			return err
		}
		discovery, err := historyPreSubscriptionRequest(c, desktopDiscoverOwner, "")
		if err != nil {
			return err
		}
		message, err := historyPreSubscriptionBroadcast(desktopFollowingChanged, "unconfirmed-owner", false)
		if err != nil {
			return err
		}
		if err := c.write(message); err != nil {
			return err
		}
		if err := historyFixtureReply(c, discovery, historyPreSubscriptionOwnerID, map[string]any{}); err != nil {
			return err
		}
		settings, err := historyPreSubscriptionRequest(c, desktopReadSettings, historyPreSubscriptionOwnerID)
		if err != nil {
			return err
		}
		for _, method := range []string{desktopStateChanged, desktopFollowingChanged} {
			message, err := historyPreSubscriptionBroadcast(method, historyPreSubscriptionOwnerID, false)
			if err != nil {
				return err
			}
			if err := c.write(message); err != nil {
				return err
			}
		}
		if err := historyFixtureReply(c, settings, historyPreSubscriptionOwnerID,
			map[string]any{"settings": map[string]any{"mode": "default", "threadSource": "user", "resumeState": "resumed"}}); err != nil {
			return err
		}
		follow, err := c.read()
		if err != nil {
			return err
		}
		params = map[string]any{}
		if json.Unmarshal(follow.Params, &params) != nil || follow.Type != "broadcast" || follow.Method != desktopFollowingChanged ||
			follow.Version != 1 || follow.SourceClientID != historyPreSubscriptionClientID ||
			!reflect.DeepEqual(follow.TargetClientIDs, []string{historyPreSubscriptionOwnerID}) ||
			params["conversationId"] != "session" || params["hostId"] != "local" || params["following"] != true {
			return fmt.Errorf("unexpected history subscription: %s", follow.Method)
		}
		state := historyTestState(false, historyTestTurn("recorded-turn", historyTestItem("recorded-item", "agentMessage", "recorded answer")))
		if err := historyFixtureChange(c, map[string]any{"type": "snapshot", "revision": 1, "conversationState": state}); err != nil {
			return err
		}
		return historyFixtureEnd(c)
	})
	reader := NewDesktopHistoryReader(path)
	t.Cleanup(reader.Reset)
	ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
	defer cancel()
	history, generation, err := reader.ReadHistory(ctx, "session", "", "", 50)
	if err != nil {
		t.Fatalf("first context-free history read: %v", err)
	}
	if generation == "" || history.HistoryContext != generation || history.Source != protocol.HistorySourceDesktop || history.Session.ID != "session" ||
		len(history.Items) != 1 || history.Items[0].ID != "recorded-item" || history.Items[0].TurnID != "recorded-turn" || history.Items[0].Text != "recorded answer" {
		t.Fatal("first page did not come exclusively from subscribed recorded snapshot")
	}
}
