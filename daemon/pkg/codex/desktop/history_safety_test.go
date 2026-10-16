package desktop

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func historyUnitEntry() *desktopHistoryEntry {
	return &desktopHistoryEntry{sessionID: "session", generation: "generation", changed: make(chan struct{}), cursors: map[string]desktopHistoryAnchor{}, anchorTokens: map[desktopHistoryAnchor]string{}}
}

func historyUnitChange(t *testing.T, entry *desktopHistoryEntry, change map[string]any) error {
	t.Helper()
	params, err := json.Marshal(map[string]any{"conversationId": "session", "hostId": "local", "change": change})
	if err != nil {
		t.Fatal(err)
	}
	return entry.change(params)
}

func TestDesktopHistoryChangeInvalidatesRevisionGenerationAndPrefix(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(map[string]any) map[string]any
	}{
		{"gap", func(_ map[string]any) map[string]any { return desktopPatchChange(0, 2) }},
		{"repeat", func(_ map[string]any) map[string]any { return desktopPatchChange(1, 1) }},
		{"generation", func(_ map[string]any) map[string]any {
			return desktopPatchChange(1, 2, map[string]any{"op": "replace", "path": []any{"turnHistory", "history", "generation"}, "value": "new"})
		}},
		{"root target", func(s map[string]any) map[string]any {
			s["id"] = "other"
			return desktopPatchChange(1, 2, map[string]any{"op": "replace", "path": []any{}, "value": s})
		}},
		{"identity patch", func(_ map[string]any) map[string]any {
			return desktopPatchChange(1, 2, map[string]any{"op": "replace", "path": []any{"id"}, "value": "session"})
		}},
		{"reorder", func(_ map[string]any) map[string]any {
			return desktopPatchChange(1, 2, map[string]any{"op": "replace", "path": []any{"turnHistory", "history", "entitiesByKey", "k", "items"}, "value": []any{historyTestItem("second", "agentMessage", "b"), historyTestItem("first", "userMessage", "a")}})
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			entry := historyUnitEntry()
			state := historyTestState(true, historyTestTurn("turn", historyTestItem("first", "userMessage", "a"), historyTestItem("second", "agentMessage", "b")))
			if err := historyUnitChange(t, entry, map[string]any{"type": "snapshot", "revision": 1, "conversationState": state}); err != nil {
				t.Fatal(err)
			}
			if err := historyUnitChange(t, entry, tc.change(state)); err == nil {
				t.Fatal("invalid change accepted")
			}
			if entry.revision != 1 || entry.view.items[0].ID != "first" {
				t.Fatal("failed change partially committed")
			}
		})
	}
}

func TestDesktopHistoryPatchExactKeysArraysEscapesAndBounds(t *testing.T) {
	raw := []byte(`{"a/b~":{"items":["first","last"]}}`)
	patches := []desktopPatch{{Op: "add", Path: []any{"a/b~", "items", float64(1)}, Value: json.RawMessage(`"middle"`)}, {Op: "replace", Path: []any{"a/b~", "items", float64(0)}, Value: json.RawMessage(`"updated"`)}, {Op: "remove", Path: []any{"a/b~", "items", float64(2)}}}
	_, state, err := applyDesktopHistoryPatches(raw, patches)
	if err != nil {
		t.Fatal(err)
	}
	items := state["a/b~"].(map[string]any)["items"].([]any)
	if len(items) != 2 || items[0] != "updated" || items[1] != "middle" {
		t.Fatalf("array patch=%v", items)
	}
	for _, patch := range []desktopPatch{
		{Op: "add", Path: []any{"a/b~", "items", float64(9)}, Value: json.RawMessage(`null`)},
		{Op: "remove", Path: []any{"a/b~", "items", float64(-1)}},
		{Op: "replace", Path: []any{"a/b~", "items", "0"}, Value: json.RawMessage(`null`)},
		{Op: "replace", Path: []any{"a/b~", float64(0)}, Value: json.RawMessage(`null`)},
		{Op: "replace", Path: []any{"missing"}, Value: json.RawMessage(`null`)},
		{Op: "remove", Path: []any{}},
		{Op: "move", Path: []any{"a/b~"}},
		{Op: "add", Path: nil, Value: json.RawMessage(`null`)},
	} {
		if _, _, err := applyDesktopHistoryPatches(raw, []desktopPatch{patch}); err == nil {
			t.Fatalf("bad patch accepted=%+v", patch)
		}
	}
	tooDeep := []byte(strings.Repeat(`{"a":`, desktopHistoryDepthLimit+1) + `null` + strings.Repeat(`}`, desktopHistoryDepthLimit+1))
	if _, err := decodeDesktopHistoryState(tooDeep); err == nil || err.Error() != protocol.HistoryTooLarge {
		t.Fatalf("depth bound=%v", err)
	}
	if _, _, err := applyDesktopHistoryPatches(raw, make([]desktopPatch, desktopHistoryPatchLimit+1)); err == nil || err.Error() != protocol.HistoryTooLarge {
		t.Fatalf("patch count=%v", err)
	}
	if _, err := historyPatches([]any{map[string]any{"Op": "replace", "Path": []any{}, "Value": map[string]any{}}}); err == nil {
		t.Fatal("case-folded patch accepted")
	}
}

func TestDesktopHistoryResponsesRejectWrongMethodOwnerAndRevision(t *testing.T) {
	for _, method := range []string{desktopDiscoverOwner, desktopReadSettings, desktopLoadCompleteHistory} {
		for _, suffix := range []string{"-wrong", "-future"} {
			t.Run(method+suffix, func(t *testing.T) {
				stream := desktopHistoryStream{entry: historyUnitEntry(), owner: "owner", requestID: "request", method: method, deadline: time.Now().Add(time.Second)}
				err := stream.handle(desktopEnvelope{Type: "response", RequestID: "request", Method: method + suffix, ResultType: "success", HandledByClientID: "owner", Result: json.RawMessage(`{"revision":1}`)})
				if err == nil {
					t.Fatal("wrong response method accepted")
				}
			})
		}
	}
	for _, result := range []json.RawMessage{json.RawMessage(`{}`), json.RawMessage(`{"revision":-1}`), json.RawMessage(`{"revision":1.5}`), json.RawMessage(`{"Revision":1}`), json.RawMessage(`{"revision":"1"}`)} {
		stream := desktopHistoryStream{entry: historyUnitEntry(), owner: "owner", requestID: "request", method: desktopLoadCompleteHistory, deadline: time.Now().Add(time.Second)}
		if err := stream.handle(desktopEnvelope{Type: "response", RequestID: "request", Method: desktopLoadCompleteHistory, Version: 1, ResultType: "success", HandledByClientID: "owner", Result: result}); err == nil {
			t.Fatalf("bad revision accepted=%s", result)
		}
	}
	stream := desktopHistoryStream{entry: historyUnitEntry(), owner: "owner", requestID: "request", method: desktopReadSettings, deadline: time.Now().Add(time.Second)}
	if err := stream.handle(desktopEnvelope{Type: "response", RequestID: "request", Method: desktopReadSettings, Version: 1, ResultType: "success", HandledByClientID: "other", Result: json.RawMessage(`{"settings":{"resumeState":"resumed","mode":"default","threadSource":"user"}}`)}); err == nil || err.Error() != protocol.HistoryContextExpired {
		t.Fatalf("owner change accepted=%v", err)
	}
}

func TestDesktopHistorySingleLoadIncompleteAndRestoredCache(t *testing.T) {
	responseSent, restore, partialAgain := make(chan struct{}), make(chan struct{}), make(chan struct{})
	state := historyTestState(true, historyTestTurn("turn", historyTestItem("item", "agentMessage", "body")))
	historyTestCanonical(state)["isComplete"] = false
	path := desktopFixture(t, func(c *desktopConn) error {
		if err := historyFixtureStart(c, state); err != nil {
			return err
		}
		request, err := historyFixtureLoad(c)
		if err != nil {
			return err
		}
		if err := historyFixtureReply(c, request, "owner", map[string]any{"revision": 1}); err != nil {
			return err
		}
		close(responseSent)
		<-restore
		if err := historyFixtureChange(c, desktopPatchChange(1, 2, map[string]any{"op": "replace", "path": []any{"turnHistory", "history", "isComplete"}, "value": true})); err != nil {
			return err
		}
		<-partialAgain
		if err := historyFixtureChange(c, desktopPatchChange(2, 3, map[string]any{"op": "replace", "path": []any{"turnHistory", "history", "isComplete"}, "value": false})); err != nil {
			return err
		}
		return historyFixtureEnd(c)
	})
	reader := NewDesktopHistoryReader(path)
	t.Cleanup(reader.Reset)
	ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
	defer cancel()
	_, _, err := reader.ReadHistory(ctx, "session", "", "", 2)
	if err == nil || err.Error() != protocol.HistoryIncomplete {
		t.Fatalf("partial exported=%v", err)
	}
	historyWaitSignal(t, responseSent)
	reader.mu.Lock()
	generation := reader.entries["session"].generation
	reader.mu.Unlock()
	close(restore)
	historyWaitRevision(t, reader, 2)
	if _, same, err := reader.ReadHistory(ctx, "session", generation, "", 2); err != nil || same != generation {
		t.Fatalf("restored=%v generation=%s", err, same)
	}
	close(partialAgain)
	historyWaitRevision(t, reader, 3)
	if _, _, err := reader.ReadHistory(ctx, "session", generation, "", 2); err == nil || err.Error() != protocol.HistoryIncomplete {
		t.Fatalf("repeated partial=%v", err)
	}
}

func TestDesktopHistoryTargetLimitAndExpiredGenerationDoNotConnect(t *testing.T) {
	reader := NewDesktopHistoryReader("must-not-connect")
	for _, id := range []string{"one", "two", "three", "four"} {
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		close(done)
		reader.entries[id] = &desktopHistoryEntry{ctx: ctx, cancel: cancel, done: done, lastUsed: time.Now(), active: 1, generation: "existing"}
	}
	defer reader.Reset()
	if _, err := reader.acquire("five", ""); err == nil || err.Error() != protocol.HistoryBusy {
		t.Fatalf("target bound=%v", err)
	}
	if _, err := reader.acquire("five", "missing-generation"); err == nil || err.Error() != protocol.HistoryContextExpired {
		t.Fatalf("missing generation connected=%v", err)
	}
	if _, err := reader.acquire("one", "different-generation"); err == nil || err.Error() != protocol.HistoryContextExpired {
		t.Fatalf("generation changed=%v", err)
	}
}

func TestDesktopHistoryConnectionErrorAndReusableReset(t *testing.T) {
	closeOwner := make(chan struct{})
	path := desktopFixture(t, func(c *desktopConn) error {
		if err := historyFixtureStart(c, historyTestState(false)); err != nil {
			return err
		}
		<-closeOwner
		return nil
	})
	reader := NewDesktopHistoryReader(path)
	t.Cleanup(reader.Reset)
	ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
	defer cancel()
	_, generation, err := reader.ReadHistory(ctx, "session", "", "", 2)
	if err != nil {
		t.Fatal(err)
	}
	reader.mu.Lock()
	entry := reader.entries["session"]
	reader.mu.Unlock()
	close(closeOwner)
	historyWaitSignal(t, entry.done)
	if _, _, err := reader.ReadHistory(ctx, "session", generation, "", 2); err == nil || err.Error() != protocol.HistoryContextExpired {
		t.Fatalf("connection error retained context=%v", err)
	}
	reader.Reset()
	newPath := desktopFixture(t, func(c *desktopConn) error {
		if err := historyFixtureStart(c, historyTestState(false)); err != nil {
			return err
		}
		return historyFixtureEnd(c)
	})
	reader.socketPath = newPath
	_, fresh, err := reader.ReadHistory(ctx, "session", "", "", 2)
	if err != nil || fresh == generation || fresh == "" {
		t.Fatalf("reset not reusable generation=%s err=%v", fresh, err)
	}
	reader.Reset()
}
