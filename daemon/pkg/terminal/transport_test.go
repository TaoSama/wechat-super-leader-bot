package terminal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestStrictResponseEnvelopeAndHandshake(t *testing.T) {
	cases := []struct {
		name  string
		frame func(testRequest) []byte
	}{
		{"wrong-id", func(r testRequest) []byte {
			return []byte(`{"id":"wrong","result":{"type":"pong","protocol":22,"version":"test"}}` + "\n")
		}},
		{"numeric-id", func(r testRequest) []byte { return []byte(`{"id":1,"result":{}}` + "\n") }},
		{"both", func(r testRequest) []byte {
			return []byte(fmt.Sprintf(`{"id":%q,"result":{},"error":{"code":"x","message":"PRIVATE_BODY"}}`+"\n", r.ID))
		}},
		{"neither", func(r testRequest) []byte { return []byte(fmt.Sprintf(`{"id":%q}`+"\n", r.ID)) }},
		{"null-result", func(r testRequest) []byte { return encodedResponse(t, r, nil) }},
		{"null-error", func(r testRequest) []byte { return []byte(fmt.Sprintf(`{"id":%q,"error":null}`+"\n", r.ID)) }},
		{"host-error", func(r testRequest) []byte {
			return []byte(fmt.Sprintf(`{"id":%q,"error":{"code":"PRIVATE_TOKEN","message":"PRIVATE_BODY"}}`+"\n", r.ID))
		}},
		{"error-missing-message", func(r testRequest) []byte { return []byte(fmt.Sprintf(`{"id":%q,"error":{"code":"x"}}`+"\n", r.ID)) }},
		{"error-unknown-field", func(r testRequest) []byte {
			return []byte(fmt.Sprintf(`{"id":%q,"error":{"code":"x","message":"PRIVATE_BODY","extra":true}}`+"\n", r.ID))
		}},
		{"envelope-unknown-field", func(r testRequest) []byte {
			return []byte(fmt.Sprintf(`{"id":%q,"extra":"PRIVATE_TOKEN","result":{"type":"pong","protocol":22,"version":"test"}}`+"\n", r.ID))
		}},
		{"uppercase-key", func(r testRequest) []byte {
			return []byte(fmt.Sprintf(`{"ID":%q,"result":{"type":"pong","protocol":22,"version":"test"}}`+"\n", r.ID))
		}},
		{"duplicate-id", func(r testRequest) []byte {
			return []byte(fmt.Sprintf(`{"id":%q,"id":%q,"result":{"type":"pong","protocol":22,"version":"test"}}`+"\n", r.ID, r.ID))
		}},
		{"duplicate-protocol", func(r testRequest) []byte {
			return []byte(fmt.Sprintf(`{"id":%q,"result":{"type":"pong","protocol":22,"protocol":22,"version":"test"}}`+"\n", r.ID))
		}},
		{"malformed", func(r testRequest) []byte { return []byte("PRIVATE_BODY invalid JSON\n") }},
		{"array", func(r testRequest) []byte { return []byte("[]\n") }},
		{"two-values", func(r testRequest) []byte {
			return append(encodedResponse(t, r, pongResult())[:len(encodedResponse(t, r, pongResult()))-1], []byte(" {}\n")...)
		}},
		{"invalid-utf8", func(r testRequest) []byte {
			return []byte(fmt.Sprintf("{\"id\":%q,\"result\":{\"type\":\"pong\",\"protocol\":22,\"version\":\"\xff\"}}\n", r.ID))
		}},
		{"oversize", func(r testRequest) []byte { return []byte(strings.Repeat("x", MaxResponseBytes+1) + "\n") }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			host := newTestHost(t, func(r testRequest, _, _ int) []byte { return tc.frame(r) })
			sessions, err := NewObserver(host.socket, []string{"w1:p1"}).DiscoverSessions(context.Background())
			if err == nil || sessions != nil {
				t.Fatal("invalid envelope accepted")
			}
			if strings.Contains(err.Error(), "PRIVATE_") {
				t.Fatal("error leaked host data")
			}
			if methods := host.methods(); len(methods) != 1 || methods[0] != "ping" {
				t.Fatal("continued after invalid handshake")
			}
		})
	}
	mutations := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"wrong-type", func(p map[string]any) { p["type"] = "agent_info" }},
		{"old-protocol", func(p map[string]any) { p["protocol"] = 21 }},
		{"future-protocol", func(p map[string]any) { p["protocol"] = 23 }},
		{"protocol-string", func(p map[string]any) { p["protocol"] = "22" }},
		{"protocol-fraction", func(p map[string]any) { p["protocol"] = 22.5 }},
		{"protocol-missing", func(p map[string]any) { delete(p, "protocol") }},
		{"version-missing", func(p map[string]any) { delete(p, "version") }},
		{"unknown-field", func(p map[string]any) { p["secret"] = "PRIVATE_BODY" }},
		{"capabilities-missing-required", func(p map[string]any) { p["capabilities"] = map[string]any{} }},
		{"capabilities-unknown", func(p map[string]any) { p["capabilities"] = map[string]any{"live_handoff": true, "new_field": true} }},
		{"capabilities-null-bool", func(p map[string]any) { p["capabilities"] = map[string]any{"live_handoff": true, "health_check": nil} }},
	}
	for _, tc := range mutations {
		t.Run(tc.name, func(t *testing.T) {
			host := newTestHost(t, func(r testRequest, _, _ int) []byte {
				result := pongResult()
				tc.mutate(result)
				return encodedResponse(t, r, result)
			})
			if _, err := NewObserver(host.socket, []string{"w1:p1"}).DiscoverSessions(context.Background()); err == nil {
				t.Fatal("bad handshake accepted")
			}
		})
	}
}

func TestRequiredAgentSchemaAndOptionalFields(t *testing.T) {
	mutations := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"pane-wrong", func(a map[string]any) { a["pane_id"] = "w1:p2" }},
		{"terminal-missing", func(a map[string]any) { delete(a, "terminal_id") }},
		{"workspace-missing", func(a map[string]any) { delete(a, "workspace_id") }},
		{"tab-missing", func(a map[string]any) { delete(a, "tab_id") }},
		{"focused-missing", func(a map[string]any) { delete(a, "focused") }},
		{"focused-null", func(a map[string]any) { a["focused"] = nil }},
		{"revision-missing", func(a map[string]any) { delete(a, "revision") }},
		{"revision-fraction", func(a map[string]any) { a["revision"] = 1.5 }},
		{"revision-negative", func(a map[string]any) { a["revision"] = -1 }},
		{"revision-overflow", func(a map[string]any) { a["revision"] = json.Number("18446744073709551616") }},
		{"status-unknown-enum", func(a map[string]any) { a["agent_status"] = "invented" }},
		{"provider-empty", func(a map[string]any) { a["agent"] = "" }},
		{"unknown-field", func(a map[string]any) { a["future"] = "PRIVATE_BODY" }},
		{"uppercase-identity", func(a map[string]any) { a["Terminal_id"] = a["terminal_id"]; delete(a, "terminal_id") }},
		{"session-kind", func(a map[string]any) { a["agent_session"].(map[string]any)["kind"] = "file" }},
		{"session-provider-mismatch", func(a map[string]any) { a["agent_session"].(map[string]any)["agent"] = "claude" }},
		{"identity-escape", func(a map[string]any) { a["terminal_id"] = "bad\x1bidentity" }},
		{"identity-del", func(a map[string]any) { a["workspace_id"] = "bad\x7fidentity" }},
		{"identity-unicode-control", func(a map[string]any) { a["tab_id"] = "bad\u0085identity" }},
		{"session-source-missing", func(a map[string]any) { delete(a["agent_session"].(map[string]any), "source") }},
		{"session-value-missing", func(a map[string]any) { delete(a["agent_session"].(map[string]any), "value") }},
		{"session-extra", func(a map[string]any) { a["agent_session"].(map[string]any)["secret"] = "PRIVATE_BODY" }},
		{"optional-bool-null", func(a map[string]any) { a["interactive_ready"] = nil }},
		{"optional-bool-string", func(a map[string]any) { a["launch_pending"] = "false" }},
		{"seq-null", func(a map[string]any) { a["state_change_seq"] = nil }},
		{"seq-negative", func(a map[string]any) { a["state_change_seq"] = -1 }},
		{"tokens-invalid-key", func(a map[string]any) { a["tokens"] = map[string]string{"bad.key": "PRIVATE_TOKEN"} }},
		{"tokens-null-value", func(a map[string]any) { a["tokens"] = map[string]any{"valid": nil} }},
		{"tokens-overlimit", func(a map[string]any) {
			tokens := map[string]string{}
			for i := 0; i < 33; i++ {
				tokens[fmt.Sprintf("key%d", i)] = "PRIVATE_TOKEN"
			}
			a["tokens"] = tokens
		}},
	}
	for _, tc := range mutations {
		t.Run(tc.name, func(t *testing.T) {
			host := newTestHost(t, func(r testRequest, _, _ int) []byte {
				result := normalResult(t, r)
				if r.Method == "agent.get" {
					tc.mutate(result["agent"].(map[string]any))
				}
				return encodedResponse(t, r, result)
			})
			sessions, err := NewObserver(host.socket, []string{"w1:p1"}).DiscoverSessions(context.Background())
			if err == nil || sessions != nil {
				t.Fatal("bad agent schema accepted")
			}
			if strings.Contains(err.Error(), "PRIVATE_") {
				t.Fatal("error leaked host data")
			}
		})
	}
	t.Run("complete-legal-schema", func(t *testing.T) {
		host := newTestHost(t, func(r testRequest, _, _ int) []byte {
			result := normalResult(t, r)
			if r.Method == "ping" {
				result["capabilities"] = map[string]any{"live_handoff": false, "detached_server_daemon": true, "health_check": false, "surface_interest": true, "endpoint_protocol_generation": nil}
			}
			if r.Method == "agent.get" {
				a := result["agent"].(map[string]any)
				for _, key := range []string{"cwd", "display_agent", "foreground_cwd", "name", "terminal_title", "terminal_title_stripped", "title"} {
					a[key] = "PRIVATE_BODY"
				}
				a["title"] = "safe test title"
				a["foreground_cwd"] = "/safe/test/workspace"
				a["interactive_ready"] = true
				a["launch_pending"] = false
				a["screen_detection_skipped"] = false
				a["state_change_seq"] = 0
				a["state_labels"] = map[string]string{"status": "value"}
				a["tokens"] = map[string]string{"valid": "PRIVATE_TOKEN"}
			}
			return encodedResponse(t, r, result)
		})
		sessions, err := NewObserver(host.socket, []string{"w1:p1"}).DiscoverSessions(context.Background())
		if err != nil || len(sessions) != 1 {
			t.Fatalf("optional schema rejected: %v", err)
		}
		public, err := json.Marshal(sessions)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(public), "PRIVATE_") {
			t.Fatal("private optional fields exposed")
		}
	})
}

func TestTimeoutAndCancellation(t *testing.T) {
	for _, mode := range []string{"rpc-timeout", "operation-timeout", "context-deadline", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			seen := make(chan struct{}, 1)
			host := newTestHost(t, func(r testRequest, _, _ int) []byte { seen <- struct{}{}; return nil })
			observer := NewObserver(host.socket, []string{"w1:p1"})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch mode {
			case "rpc-timeout":
				observer.rpcTimeout = 30 * time.Millisecond
			case "operation-timeout":
				observer.operationTimeout = 30 * time.Millisecond
			case "context-deadline":
				var stop context.CancelFunc
				ctx, stop = context.WithTimeout(ctx, 30*time.Millisecond)
				defer stop()
			}
			finished := make(chan error, 1)
			go func() { _, err := observer.DiscoverSessions(ctx); finished <- err }()
			select {
			case <-seen:
			case <-time.After(time.Second):
				t.Fatal("no request")
			}
			if mode == "cancel" {
				cancel()
			}
			select {
			case err := <-finished:
				if mode == "cancel" {
					if !errors.Is(err, context.Canceled) {
						t.Fatalf("cancellation: %v", err)
					}
				} else if !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("timeout: %v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("observer did not stop")
			}
		})
	}
	t.Run("cancel-during-snapshot", func(t *testing.T) {
		seen := make(chan struct{}, 1)
		host := newTestHost(t, func(r testRequest, connection, _ int) []byte {
			if connection == 2 && r.Method == "pane.read" {
				seen <- struct{}{}
				return nil
			}
			return encodedResponse(t, r, normalResult(t, r))
		})
		observer := NewObserver(host.socket, []string{"w1:p1"})
		sessions, err := observer.DiscoverSessions(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		finished := make(chan error, 1)
		go func() {
			output, err := observer.ReadSession(ctx, sessions[0].ID)
			if output != "" {
				t.Error("canceled snapshot exposed output")
			}
			finished <- err
		}()
		select {
		case <-seen:
			cancel()
		case <-time.After(time.Second):
			t.Fatal("no snapshot request")
		}
		select {
		case err := <-finished:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("cancellation: %v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("read did not stop")
		}
	})
}

func TestMalformedPaneSchemaNeverReturnsText(t *testing.T) {
	for _, field := range []string{"pane_id", "workspace_id", "tab_id", "source", "format", "text", "revision", "truncated"} {
		t.Run("missing-"+field, func(t *testing.T) {
			host := newTestHost(t, func(r testRequest, _, _ int) []byte {
				result := normalResult(t, r)
				if r.Method == "pane.read" {
					delete(result["read"].(map[string]any), field)
				}
				return encodedResponse(t, r, result)
			})
			observer := NewObserver(host.socket, []string{"w1:p1"})
			sessions, err := observer.DiscoverSessions(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if output, err := observer.ReadSession(context.Background(), sessions[0].ID); err == nil || output != "" {
				t.Fatal("missing snapshot field accepted")
			}
		})
	}
	for _, mode := range []string{"wrong-type", "hyphen-source", "unknown-field", "ansi", "null-text"} {
		t.Run(mode, func(t *testing.T) {
			host := newTestHost(t, func(r testRequest, _, _ int) []byte {
				result := normalResult(t, r)
				if r.Method == "pane.read" {
					read := result["read"].(map[string]any)
					switch mode {
					case "wrong-type":
						result["type"] = "agent_prompted"
					case "hyphen-source":
						read["source"] = "recent-unwrapped"
					case "unknown-field":
						read["token"] = "PRIVATE_TOKEN"
					case "ansi":
						read["text"] = "\x1b[31mPRIVATE_BODY"
					case "null-text":
						read["text"] = nil
					}
				}
				return encodedResponse(t, r, result)
			})
			observer := NewObserver(host.socket, []string{"w1:p1"})
			sessions, err := observer.DiscoverSessions(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			output, err := observer.ReadSession(context.Background(), sessions[0].ID)
			if err == nil || output != "" || strings.Contains(err.Error(), "PRIVATE_") {
				t.Fatal("invalid snapshot accepted or leaked")
			}
		})
	}
}
