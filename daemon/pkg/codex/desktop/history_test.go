package desktop

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func historyFixtureStart(c *desktopConn, state map[string]any) error {
	request, err := c.read()
	if err != nil {
		return err
	}
	var params map[string]any
	if json.Unmarshal(request.Params, &params) != nil || request.Method != desktopInitialize || params["clientType"] != desktopHistoryClient {
		return errors.New("wrong history initialize")
	}
	if err := historyFixtureReply(c, request, "history-client", map[string]any{"clientId": "history-client"}); err != nil {
		return err
	}
	request, err = c.read()
	if err != nil {
		return err
	}
	if json.Unmarshal(request.Params, &params) != nil || request.Method != desktopDiscoverOwner || request.Version != 1 || params["conversationId"] != "session" || params["hostId"] != "local" {
		return errors.New("wrong history discovery")
	}
	if err := historyFixtureReply(c, request, "owner", map[string]any{}); err != nil {
		return err
	}
	request, err = c.read()
	if err != nil {
		return err
	}
	params = map[string]any{}
	if json.Unmarshal(request.Params, &params) != nil || request.Method != desktopReadSettings || request.TargetClientID != "owner" || request.Version != 1 || params["conversationId"] != "session" || len(params) != 1 {
		return errors.New("wrong history settings request")
	}
	if err := historyFixtureReply(c, request, "owner", map[string]any{"settings": map[string]any{"mode": "default", "threadSource": "user", "resumeState": "resumed"}}); err != nil {
		return err
	}
	follow, err := c.read()
	if err != nil {
		return err
	}
	params = map[string]any{}
	if json.Unmarshal(follow.Params, &params) != nil || follow.Method != desktopFollowingChanged || !reflect.DeepEqual(follow.TargetClientIDs, []string{"owner"}) || params["following"] != true {
		return errors.New("wrong history follow")
	}
	return historyFixtureChange(c, map[string]any{"type": "snapshot", "revision": 1, "conversationState": state})
}

func historyFixtureChange(c *desktopConn, change map[string]any) error {
	params, err := json.Marshal(map[string]any{"conversationId": "session", "hostId": "local", "change": change})
	if err != nil {
		return err
	}
	return c.write(desktopEnvelope{Type: "broadcast", Method: desktopStateChanged, Version: 11, SourceClientID: "owner", TargetClientIDs: []string{"history-client"}, Params: params})
}

func historyFixtureReply(c *desktopConn, request desktopEnvelope, owner string, result any) error {
	encoded, err := json.Marshal(map[string]any{"type": "response", "requestId": request.RequestID, "method": request.Method,
		"resultType": "success", "handledByClientId": owner, "result": result})
	if err != nil {
		return err
	}
	frame := make([]byte, 4+len(encoded))
	binary.LittleEndian.PutUint32(frame, uint32(len(encoded)))
	copy(frame[4:], encoded)
	_, err = io.Copy(c, bytes.NewReader(frame))
	return err
}

func historyFixtureLoad(c *desktopConn) (desktopEnvelope, error) {
	request, err := c.read()
	if err != nil {
		return request, err
	}
	var params map[string]any
	if json.Unmarshal(request.Params, &params) != nil || request.Method != desktopLoadCompleteHistory || request.Version != 1 || request.TargetClientID != "owner" || params["conversationId"] != "session" || len(params) != 1 {
		return request, errors.New("wrong complete-history request")
	}
	return request, nil
}

func historyFixtureEnd(c *desktopConn) error {
	for {
		message, err := c.read()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		var params map[string]any
		if json.Unmarshal(message.Params, &params) != nil || message.Method != desktopFollowingChanged || params["following"] != false {
			return fmt.Errorf("unexpected history write: %s", message.Method)
		}
	}
}

func historyWaitSignal(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(desktopTestTimeout):
		t.Fatal("fixture signal timeout")
	}
}

func historyWaitRevision(t *testing.T, reader *DesktopHistoryReader, revision uint64) *desktopHistoryEntry {
	t.Helper()
	reader.mu.Lock()
	entry := reader.entries["session"]
	reader.mu.Unlock()
	if entry == nil {
		t.Fatal("entry absent")
	}
	ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
	defer cancel()
	for {
		entry.mu.Lock()
		done := entry.revision >= revision || entry.err != nil
		changed := entry.changed
		entry.mu.Unlock()
		if done {
			return entry
		}
		select {
		case <-changed:
		case <-ctx.Done():
			t.Fatal("revision wait timeout")
		}
	}
}

func TestDesktopHistoryLoadPatchBeforeResponseAndRevisionBarrier(t *testing.T) {
	patchSent, allowResponse, allowFinalPatch := make(chan struct{}), make(chan struct{}), make(chan struct{})
	state := historyTestState(true, historyTestTurn("turn", historyTestItem("user", "userMessage", "question")))
	historyTestCanonical(state)["isComplete"] = false
	historyTestEntity(state)["itemsPagination"] = map[string]any{"hasLoadedOldest": false}
	path := desktopFixture(t, func(c *desktopConn) error {
		if err := historyFixtureStart(c, state); err != nil {
			return err
		}
		request, err := historyFixtureLoad(c)
		if err != nil {
			return err
		}
		patch := desktopPatchChange(1, 2, map[string]any{"op": "replace", "path": []any{"turnHistory", "history", "isComplete"}, "value": true}, map[string]any{"op": "replace", "path": []any{"turnHistory", "history", "entitiesByKey", "k", "itemsPagination", "hasLoadedOldest"}, "value": true}, map[string]any{"op": "add", "path": []any{"turnHistory", "history", "entitiesByKey", "k", "items", 1}, "value": historyTestItem("assistant", "agentMessage", "before response")})
		if err := historyFixtureChange(c, patch); err != nil {
			return err
		}
		close(patchSent)
		<-allowResponse
		if err := historyFixtureReply(c, request, "owner", map[string]any{"revision": 3}); err != nil {
			return err
		}
		<-allowFinalPatch
		if err := historyFixtureChange(c, desktopPatchChange(2, 3, map[string]any{"op": "replace", "path": []any{"title"}, "value": "revision barrier reached"})); err != nil {
			return err
		}
		return historyFixtureEnd(c)
	})
	reader := NewDesktopHistoryReader(path)
	t.Cleanup(reader.Reset)
	type result struct {
		history    protocol.SessionHistory
		generation string
		err        error
	}
	done := make(chan result, 1)
	ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
	defer cancel()
	go func() { h, g, e := reader.ReadHistory(ctx, "session", "", "", 10); done <- result{h, g, e} }()
	historyWaitSignal(t, patchSent)
	entry := historyWaitRevision(t, reader, 2)
	select {
	case <-done:
		t.Fatal("returned before load response")
	default:
	}
	close(allowResponse)
	for {
		entry.mu.Lock()
		responded := entry.loadResponded
		changed := entry.changed
		entry.mu.Unlock()
		if responded {
			break
		}
		select {
		case <-changed:
		case <-ctx.Done():
			t.Fatal("response wait timeout")
		}
	}
	select {
	case <-done:
		t.Fatal("returned before response revision applied")
	default:
	}
	close(allowFinalPatch)
	select {
	case result := <-done:
		if result.err != nil || result.generation == "" || len(result.history.Items) != 2 || result.history.Items[1].Text != "before response" {
			t.Fatalf("result=%+v", result)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

func TestDesktopHistoryStableCursorUpdatesAndReorderExpires(t *testing.T) {
	update, reorder := make(chan struct{}), make(chan struct{})
	state := historyTestState(false, historyTestTurn("turn", historyTestItem("one", "userMessage", "one"), historyTestItem("two", "agentMessage", "two"), historyTestItem("three", "agentMessage", "three")))
	path := desktopFixture(t, func(c *desktopConn) error {
		if err := historyFixtureStart(c, state); err != nil {
			return err
		}
		<-update
		if err := historyFixtureChange(c, desktopPatchChange(1, 2, map[string]any{"op": "replace", "path": []any{"turns", 0, "items", 2, "text"}, "value": "updated"}, map[string]any{"op": "add", "path": []any{"turns", 0, "items", 3}, "value": historyTestItem("four", "agentMessage", "four")})); err != nil {
			return err
		}
		<-reorder
		if err := historyFixtureChange(c, desktopPatchChange(2, 3, map[string]any{"op": "remove", "path": []any{"turns", 0, "items", 0}})); err != nil {
			return err
		}
		return historyFixtureEnd(c)
	})
	reader := NewDesktopHistoryReader(path)
	t.Cleanup(reader.Reset)
	ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
	defer cancel()
	latest, generation, err := reader.ReadHistory(ctx, "session", "", "", 2)
	if err != nil || latest.NextCursor == nil || latest.Items[0].ID != "two" {
		t.Fatalf("latest=%+v err=%v", latest, err)
	}
	older, same, err := reader.ReadHistory(ctx, "session", generation, *latest.NextCursor, 2)
	if err != nil || same != generation || len(older.Items) != 1 || older.Items[0].ID != "one" || older.NextCursor != nil {
		t.Fatalf("older=%+v err=%v", older, err)
	}
	close(update)
	historyWaitRevision(t, reader, 2)
	latest, same, err = reader.ReadHistory(ctx, "session", generation, "", 2)
	if err != nil || same != generation || latest.Items[0].Text != "updated" || latest.Items[1].ID != "four" {
		t.Fatalf("updated=%+v err=%v", latest, err)
	}
	close(reorder)
	historyWaitRevision(t, reader, 3)
	if _, _, err := reader.ReadHistory(ctx, "session", generation, "", 2); err == nil || err.Error() != protocol.HistoryContextExpired {
		t.Fatalf("reordered generation=%v", err)
	}
	if _, _, err := reader.ReadHistory(ctx, "other", generation, "", 2); err == nil || err.Error() != protocol.HistoryContextExpired {
		t.Fatalf("cross-session generation=%v", err)
	}
}

func TestDesktopHistoryCanceledWaiterKeepsSharedLoad(t *testing.T) {
	loadSeen, finishLoad := make(chan struct{}), make(chan struct{})
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
		close(loadSeen)
		<-finishLoad
		if err := historyFixtureChange(c, desktopPatchChange(1, 2, map[string]any{"op": "replace", "path": []any{"turnHistory", "history", "isComplete"}, "value": true})); err != nil {
			return err
		}
		if err := historyFixtureReply(c, request, "owner", map[string]any{"revision": 2}); err != nil {
			return err
		}
		return historyFixtureEnd(c)
	})
	reader := NewDesktopHistoryReader(path)
	t.Cleanup(reader.Reset)
	ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
	defer cancel()
	firstCtx, cancelFirst := context.WithCancel(ctx)
	first, second := make(chan error, 1), make(chan error, 1)
	go func() { _, _, err := reader.ReadHistory(firstCtx, "session", "", "", 2); first <- err }()
	historyWaitSignal(t, loadSeen)
	go func() { _, _, err := reader.ReadHistory(ctx, "session", "", "", 2); second <- err }()
	cancelFirst()
	select {
	case err := <-first:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancel=%v", err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	close(finishLoad)
	select {
	case err := <-second:
		if err != nil {
			t.Fatalf("shared load canceled: %v", err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if _, _, err := reader.ReadHistory(ctx, "session", "", "", 2); err != nil {
		t.Fatalf("shared cache unavailable: %v", err)
	}
}

func TestDesktopHistoryIdleExpiryAndReset(t *testing.T) {
	path := desktopFixture(t, func(c *desktopConn) error {
		if err := historyFixtureStart(c, historyTestState(false)); err != nil {
			return err
		}
		return historyFixtureEnd(c)
	})
	reader := NewDesktopHistoryReader(path)
	reader.idleTTL = 30 * time.Millisecond
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
	historyWaitSignal(t, entry.done)
	if _, _, err := reader.ReadHistory(ctx, "session", generation, "", 2); err == nil || err.Error() != protocol.HistoryContextExpired {
		t.Fatalf("TTL did not expire: %v", err)
	}
	reader.Reset()
	reader.Reset()
	if _, _, err := reader.ReadHistory(ctx, "session", generation, "", 2); err == nil || err.Error() != protocol.HistoryContextExpired {
		t.Fatalf("reset rebuilt old generation: %v", err)
	}
}
