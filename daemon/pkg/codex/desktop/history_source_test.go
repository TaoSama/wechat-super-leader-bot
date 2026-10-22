package desktop

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

// Each request is checked before replying; the tail permits only unsubscribe.
// A start, resume or input request therefore fails the IPC fixture immediately.
func historySourceFixtureSettings(c *desktopConn, source any, present bool) error {
	initialize, err := c.read()
	if err != nil {
		return err
	}
	var params map[string]any
	if json.Unmarshal(initialize.Params, &params) != nil || initialize.Method != desktopInitialize || params["clientType"] != desktopHistoryClient {
		return fmt.Errorf("unexpected history initialize: %s", initialize.Method)
	}
	if err := historyFixtureReply(c, initialize, historyPreSubscriptionClientID, map[string]any{"clientId": historyPreSubscriptionClientID}); err != nil {
		return err
	}
	discovery, err := historyPreSubscriptionRequest(c, desktopDiscoverOwner, "")
	if err != nil {
		return err
	}
	if err := historyFixtureReply(c, discovery, historyPreSubscriptionOwnerID, map[string]any{}); err != nil {
		return err
	}
	request, err := historyPreSubscriptionRequest(c, desktopReadSettings, historyPreSubscriptionOwnerID)
	if err != nil {
		return err
	}
	settings := map[string]any{"mode": "default", "resumeState": "resumed"}
	if present {
		settings["threadSource"] = source
	}
	return historyFixtureReply(c, request, historyPreSubscriptionOwnerID, map[string]any{"settings": settings})
}

func historySourceFixtureSnapshot(c *desktopConn, state map[string]any) error {
	follow, err := c.read()
	if err != nil {
		return err
	}
	var params map[string]any
	if json.Unmarshal(follow.Params, &params) != nil || follow.Type != "broadcast" || follow.Method != desktopFollowingChanged ||
		follow.Version != 1 || follow.SourceClientID != historyPreSubscriptionClientID ||
		!reflect.DeepEqual(follow.TargetClientIDs, []string{historyPreSubscriptionOwnerID}) ||
		params["conversationId"] != "session" || params["hostId"] != "local" || params["following"] != true {
		return fmt.Errorf("unexpected history subscription: %s", follow.Method)
	}
	return historyFixtureChange(c, map[string]any{"type": "snapshot", "revision": 1, "conversationState": state})
}

func historySourceState(source any, present bool) map[string]any {
	state := historyTestState(false, historyTestTurn("turn", historyTestItem("one", "userMessage", "question"), historyTestItem("two", "agentMessage", "answer")))
	if present {
		state["threadSource"] = source
	} else {
		delete(state, "threadSource")
	}
	return state
}

func TestDesktopHistoryAgentCreatedSourceIPC(t *testing.T) {
	for _, tc := range []struct {
		name               string
		settings, snapshot any
	}{
		{"agent-created-both", "agent_created_thread", "agent_created_thread"},
		{"agent-created-settings", "agent_created_thread", "user"},
		{"agent-created-snapshot", "user", "agent_created_thread"},
		{"legacy-null", nil, nil},
		{"user", "user", "user"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := desktopFixture(t, func(c *desktopConn) error {
				if err := historySourceFixtureSettings(c, tc.settings, true); err != nil {
					return err
				}
				if err := historySourceFixtureSnapshot(c, historySourceState(tc.snapshot, true)); err != nil {
					return err
				}
				return historyFixtureEnd(c)
			})
			reader := NewDesktopHistoryReader(path)
			t.Cleanup(reader.Reset)
			ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
			defer cancel()
			page, generation, err := reader.ReadHistory(ctx, "session", "", "", 1)
			if err != nil || generation == "" || page.HistoryContext != generation || len(page.Items) != 1 || page.Items[0].ID != "two" || page.NextCursor == nil {
				t.Fatalf("first page=%+v generation=%q err=%v", page, generation, err)
			}
			older, same, err := reader.ReadHistory(ctx, "session", generation, *page.NextCursor, 1)
			if err != nil || same != generation || len(older.Items) != 1 || older.Items[0].ID != "one" || older.NextCursor != nil {
				t.Fatalf("older page=%+v generation=%q err=%v", older, same, err)
			}
		})
	}
}

func TestDesktopHistoryRejectedSourceIPC(t *testing.T) {
	for _, source := range []struct {
		name    string
		value   any
		present bool
	}{
		{"unknown", "future", true},
		{"subagent", "subagent", true},
		{"automation", "automation", true},
		{"missing", nil, false},
		{"empty", "", true},
		{"object", map[string]any{"type": "agent_created_thread"}, true},
		{"boolean", true, true},
		{"number", 1, true},
	} {
		for _, stage := range []string{"settings", "snapshot"} {
			t.Run(stage+"/"+source.name, func(t *testing.T) {
				path := desktopFixture(t, func(c *desktopConn) error {
					settingsSource, settingsPresent := any("agent_created_thread"), true
					if stage == "settings" {
						settingsSource, settingsPresent = source.value, source.present
					}
					if err := historySourceFixtureSettings(c, settingsSource, settingsPresent); err != nil {
						return err
					}
					if stage == "snapshot" {
						if err := historySourceFixtureSnapshot(c, historySourceState(source.value, source.present)); err != nil {
							return err
						}
					}
					return historyFixtureEnd(c)
				})
				reader := NewDesktopHistoryReader(path)
				t.Cleanup(reader.Reset)
				ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
				defer cancel()
				page, generation, err := reader.ReadHistory(ctx, "session", "", "", 1)
				if err == nil || err.Error() != protocol.HistoryUnavailable || generation != "" || len(page.Items) != 0 || page.NextCursor != nil {
					t.Fatalf("rejected source leaked history: page=%+v generation=%q err=%v", page, generation, err)
				}
			})
		}
	}
}

func TestDesktopHistoryAgentCreatedSourceChangeRevokesIPC(t *testing.T) {
	for _, source := range []string{"future", "subagent", "automation"} {
		for _, changeType := range []string{"snapshot", "patches"} {
			t.Run(changeType+"/"+source, func(t *testing.T) {
				change := make(chan struct{})
				path := desktopFixture(t, func(c *desktopConn) error {
					if err := historySourceFixtureSettings(c, "agent_created_thread", true); err != nil {
						return err
					}
					if err := historySourceFixtureSnapshot(c, historySourceState("agent_created_thread", true)); err != nil {
						return err
					}
					<-change
					update := map[string]any{"type": "snapshot", "revision": 2, "conversationState": historySourceState(source, true)}
					if changeType == "patches" {
						update = desktopPatchChange(1, 2, map[string]any{"op": "replace", "path": []any{"threadSource"}, "value": source})
					}
					if err := historyFixtureChange(c, update); err != nil {
						return err
					}
					return historyFixtureEnd(c)
				})
				reader := NewDesktopHistoryReader(path)
				t.Cleanup(reader.Reset)
				ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
				defer cancel()
				page, generation, err := reader.ReadHistory(ctx, "session", "", "", 1)
				if err != nil || page.NextCursor == nil {
					close(change)
					t.Fatalf("initial agent-created page=%+v err=%v", page, err)
				}
				reader.mu.Lock()
				entry := reader.entries["session"]
				reader.mu.Unlock()
				close(change)
				historyWaitSignal(t, entry.done)
				entry.mu.Lock()
				revoked := entry.err != nil && entry.err.Error() == protocol.HistoryContextExpired && len(entry.raw) == 0 &&
					len(entry.view.items) == 0 && len(entry.order) == 0 && len(entry.cursors) == 0 && len(entry.anchorTokens) == 0
				entry.mu.Unlock()
				if !revoked {
					t.Fatal("source change retained recorded history or cursor state")
				}
				for _, cursor := range []string{"", *page.NextCursor} {
					history, nextGeneration, err := reader.ReadHistory(ctx, "session", generation, cursor, 1)
					if err == nil || err.Error() != protocol.HistoryContextExpired || nextGeneration != "" || len(history.Items) != 0 {
						t.Fatalf("revoked generation remained readable: history=%+v generation=%q err=%v", history, nextGeneration, err)
					}
				}
			})
		}
	}
}
