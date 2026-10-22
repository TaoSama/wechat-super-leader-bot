package appserver_test

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/appserver"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/gorilla/websocket"
)

func historyServer(t *testing.T, handler func(string, map[string]any) map[string]any) (string, func()) {
	t.Helper()
	return fakeAppServer(t, func(conn *websocket.Conn) {
		for {
			var req map[string]any
			if err := conn.ReadJSON(&req); err != nil {
				return
			}
			method, _ := req["method"].(string)
			params, _ := req["params"].(map[string]any)
			var result map[string]any
			switch method {
			case "initialized":
				continue
			case "initialize":
				capabilities, _ := params["capabilities"].(map[string]any)
				if capabilities["experimentalApi"] != true {
					t.Error("experimentalApi must be enabled")
				}
				result = map[string]any{}
			case "thread/turns/list":
				if params["itemsView"] != "notLoaded" || params["sortDirection"] != "desc" || params["limit"] != float64(50) {
					t.Error("turn status must use bounded metadata without loading items")
				}
				result = map[string]any{"data": []any{map[string]any{"id": "turn", "status": "completed", "items": []any{}}}}
			default:
				result = handler(method, params)
			}
			if err := conn.WriteJSON(map[string]any{"id": req["id"], "result": result}); err != nil {
				return
			}
		}
	})
}

func historyWrapper(id, kind string, text any) map[string]any {
	item := map[string]any{"id": id, "type": kind, "text": text}
	if kind == "userMessage" {
		item["content"] = []any{map[string]any{"type": "text", "text": text}}
	}
	return map[string]any{"turnId": "turn", "item": item, "startedAtMs": float64(1791676800000)}
}

func TestReadHistoryReadonlyAndPublicProjection(t *testing.T) {
	sock, cleanup := historyServer(t, func(method string, params map[string]any) map[string]any {
		switch method {
		case "thread/read":
			if params["threadId"] != "session" || params["includeTurns"] != false {
				t.Error("history must read metadata only")
			}
			return map[string]any{"thread": map[string]any{"id": "session", "status": map[string]any{"type": "idle"}, "model": "actual", "modelProvider": "provider", "reasoningEffort": "high", "updatedAt": float64(1791676800)}}
		case "thread/items/list":
			if params["limit"] != float64(30) || params["sortDirection"] != "desc" || params["cursor"] != "opaque" {
				t.Error("incorrect history pagination")
			}
			tool := map[string]any{"turnId": "turn", "item": map[string]any{"id": "tool", "type": "functionCallOutput", "output": "visible tool result", "internalObject": map[string]any{"private": "PRIVATE OBJECT"}}}
			return map[string]any{"data": []any{historyWrapper("new", "agentMessage", "assistant"), historyWrapper("hidden", "reasoning", "PRIVATE REASONING"), historyWrapper("unknown", "futureType", "PRIVATE OBJECT"), tool, historyWrapper("old", "userMessage", "user")}, "nextCursor": "older", "backwardsCursor": "do-not-export"}
		default:
			t.Errorf("unexpected mutating or full-history method: %s", method)
			return nil
		}
	})
	defer cleanup()
	history, err := appserver.NewAppServerAdapter(sock).ReadHistory(context.Background(), "session", "opaque", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(history.Items) != 3 || history.Items[0].ID != "old" || history.Items[1].ID != "tool" || history.Items[2].ID != "new" || history.Items[1].Kind != "tool" || history.Items[1].Text != "visible tool result" {
		t.Fatalf("incorrect public order: %+v", history.Items)
	}
	if history.Session.Model != "actual" || history.Session.ModelProvider != "provider" || history.Session.ReasoningEffort != "high" || history.Session.Loaded != nil || history.Session.UpdatedAt != "2026-10-11T00:00:00Z" || len(history.Session.Capabilities) != 1 || history.Session.Capabilities[0] != protocol.ActionRead {
		t.Fatalf("incorrect native metadata: %+v", history.Session)
	}
	if history.NextCursor == nil || *history.NextCursor != "older" || history.Items[0].Timestamp != "2026-10-11T00:00:00Z" {
		t.Fatal("missing native pagination or timestamps")
	}
	encoded, err := json.Marshal(history)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), `"loaded":`) {
		t.Fatal("history must omit unobserved loaded state")
	}
	if strings.Contains(string(encoded), "PRIVATE") || strings.Contains(string(encoded), "do-not-export") {
		t.Fatal("raw private objects leaked")
	}
}

func TestHistoryFirstPageReadsOnlyOneBoundedTailAndTargetMetadata(t *testing.T) {
	const pageSize = 20
	var tailReads, metadataReads atomic.Int32
	items := make([]any, pageSize)
	for index := range items {
		items[index] = historyWrapper("item-"+strings.Repeat("x", index), "agentMessage", strings.Repeat("历史text", 2000))
	}
	sock, cleanup := historyServer(t, func(method string, params map[string]any) map[string]any {
		switch method {
		case "thread/read":
			metadataReads.Add(1)
			if params["includeTurns"] != false || params["threadId"] != "session" {
				t.Error("first page requested full history or a different target")
			}
			return map[string]any{"thread": map[string]any{"id": "session", "status": "idle"}}
		case "thread/items/list":
			tailReads.Add(1)
			if params["limit"] != float64(pageSize) || params["sortDirection"] != "desc" || params["cursor"] != nil {
				t.Error("first page did not request a bounded recent suffix")
			}
			return map[string]any{"data": items, "nextCursor": "opaque-older"}
		default:
			t.Errorf("first page depended on unrelated RPC: %s", method)
			return nil
		}
	})
	defer cleanup()
	started := time.Now()
	history, err := appserver.NewAppServerAdapter(sock).ReadHistory(context.Background(), "session", "", pageSize)
	elapsed := time.Since(started)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(history)
	if err != nil || len(encoded) >= protocol.MaxHistoryResponseBytes || len(history.Items) != pageSize ||
		history.NextCursor == nil || *history.NextCursor != "opaque-older" || tailReads.Load() != 1 || metadataReads.Load() != 1 {
		t.Fatal("first page exceeded its read or response bounds")
	}
	t.Logf("fixture first_page_ms=%.2f public_items=%d response_bytes=%d tail_reads=%d metadata_reads=%d", float64(elapsed.Microseconds())/1000, len(history.Items), len(encoded), tailReads.Load(), metadataReads.Load())
}

func TestReadHistoryRejectsWrongSessionAndCursorCycle(t *testing.T) {
	for _, wrongSession := range []bool{true, false} {
		sock, cleanup := historyServer(t, func(method string, params map[string]any) map[string]any {
			switch method {
			case "thread/loaded/list":
				return map[string]any{"data": []any{}}
			case "thread/read":
				id := "session"
				if wrongSession {
					id = "other"
				}
				return map[string]any{"thread": map[string]any{"id": id}}
			case "thread/items/list":
				return map[string]any{"data": []any{}, "nextCursor": "same"}
			default:
				t.Errorf("unexpected method %s", method)
				return nil
			}
		})
		_, err := appserver.NewAppServerAdapter(sock).ReadHistory(context.Background(), "session", "same", 30)
		cleanup()
		if err == nil || err.Error() != protocol.HistoryFailed {
			t.Fatalf("expected static error, got %v", err)
		}
	}
}

func TestReadHistoryResponseBoundAndTruncation(t *testing.T) {
	// JSON escaping expands these bytes sixfold, exercising the complete envelope limit.
	items := []any{}
	for i := 0; i < protocol.MaxHistoryLimit; i++ {
		items = append(items, historyWrapper("item-"+strings.Repeat("x", i), "agentMessage", strings.Repeat("\x00", 20000)))
	}
	sock, cleanup := historyServer(t, func(method string, params map[string]any) map[string]any {
		switch method {
		case "thread/loaded/list":
			return map[string]any{"data": []any{}}
		case "thread/read":
			return map[string]any{"thread": map[string]any{"id": "session", "status": "notLoaded"}}
		case "thread/items/list":
			return map[string]any{"data": items}
		default:
			t.Errorf("unexpected method %s", method)
			return nil
		}
	})
	defer cleanup()
	history, err := appserver.NewAppServerAdapter(sock).ReadHistory(context.Background(), "session", "", 50)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(protocol.DaemonHistoryMessage{Type: "history", RequestID: "request", SessionID: "session", History: &history})
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) >= protocol.MaxHistoryResponseBytes || !history.Truncated || len(history.Items) != 50 {
		t.Fatalf("incorrect bound: size=%d truncated=%v items=%d", len(encoded), history.Truncated, len(history.Items))
	}
	for _, item := range history.Items {
		if !item.Truncated || len(item.Text) > protocol.MaxHistoryTextLength {
			t.Fatal("truncation must be explicit")
		}
	}
}

func TestDiscoverAllSourcesAndPages(t *testing.T) {
	sock, cleanup := historyServer(t, func(method string, params map[string]any) map[string]any {
		switch method {
		case "thread/loaded/list":
			return map[string]any{"data": []string{"live", "contradiction"}}
		case "thread/list":
			sources, _ := params["sourceKinds"].([]any)
			if len(sources) != 3 || sources[0] != "cli" || sources[1] != "vscode" || sources[2] != "appServer" {
				t.Error("source kinds missing")
			}
			if params["cursor"] == nil {
				return map[string]any{"data": []any{map[string]any{"id": "live", "status": "idle", "model": "thread-model", "preview": "preview"}}, "nextCursor": "second"}
			}
			return map[string]any{"data": []any{map[string]any{"id": "live", "status": "idle"}, map[string]any{"id": "contradiction", "status": "notLoaded"}, map[string]any{"id": "old", "status": "notLoaded"}}}
		default:
			t.Errorf("unexpected method: %s", method)
			return nil
		}
	})
	defer cleanup()
	sessions, err := appserver.NewAppServerAdapter(sock).DiscoverSessions(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 3 || sessions[0].Model != "thread-model" || sessions[0].Preview != "preview" || sessions[1].Loaded == nil || *sessions[1].Loaded || len(sessions[1].Capabilities) != 2 || sessions[1].Capabilities[1] != protocol.CapabilityResumeSend || sessions[2].Model != "" {
		t.Fatalf("incorrect session metadata: %+v", sessions)
	}
}

func TestReadHistoryUnicodeAndEscapedToolTitles(t *testing.T) {
	items := []any{}
	for i := 0; i < protocol.MaxHistoryLimit; i++ {
		items = append(items, map[string]any{"turnId": "turn", "item": map[string]any{"id": "tool-" + strings.Repeat("x", i), "type": "commandExecution", "command": strings.Repeat("\x00", 6000), "aggregatedOutput": strings.Repeat("界😀", 6000)}})
	}
	sock, cleanup := historyServer(t, func(method string, params map[string]any) map[string]any {
		switch method {
		case "thread/loaded/list":
			return map[string]any{"data": []any{}}
		case "thread/read":
			return map[string]any{"thread": map[string]any{"id": "session", "status": "notLoaded"}}
		case "thread/items/list":
			return map[string]any{"data": items}
		default:
			t.Errorf("unexpected method %s", method)
			return nil
		}
	})
	defer cleanup()
	history, err := appserver.NewAppServerAdapter(sock).ReadHistory(context.Background(), "session", "", 50)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(history)
	if err != nil || len(encoded) >= protocol.MaxHistoryResponseBytes {
		t.Fatal("escaped tool titles must fit the response budget")
	}
	for _, item := range history.Items {
		if !item.Truncated || !utf8.ValidString(item.Text) || len(item.Text) > protocol.MaxHistoryTextLength {
			t.Fatal("unicode content must be truncated on UTF-8 boundaries")
		}
	}
}

func TestDiscoveryCursorCycleFails(t *testing.T) {
	sock, cleanup := historyServer(t, func(method string, params map[string]any) map[string]any {
		if method == "thread/loaded/list" {
			return map[string]any{"data": []any{}}
		}
		if method != "thread/list" {
			t.Errorf("unexpected method %s", method)
		}
		return map[string]any{"data": []any{}, "nextCursor": "repeat"}
	})
	defer cleanup()
	_, err := appserver.NewAppServerAdapter(sock).DiscoverSessions(context.Background())
	if err == nil {
		t.Fatal("cursor cycle must fail instead of looping")
	}
}
