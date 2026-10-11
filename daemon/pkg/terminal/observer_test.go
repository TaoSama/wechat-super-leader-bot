package terminal

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestDiscoveryAndReadOnlySnapshot(t *testing.T) {
	host := newTestHost(t, func(request testRequest, _, _ int) []byte {
		return encodedResponse(t, request, normalResult(t, request))
	})
	panes := []string{"w1:p1"}
	observer := NewObserver(host.socket, panes)
	panes[0] = "focus"
	if len(host.methods()) != 0 {
		t.Fatal("constructor connected")
	}
	sessions, err := observer.DiscoverSessions(context.Background())
	if err != nil || len(sessions) != 1 {
		t.Fatalf("discovery: count=%d err=%v", len(sessions), err)
	}
	session := sessions[0]
	if !sessionPattern.MatchString(session.ID) || len(session.ID) != 52 {
		t.Fatal("public identity format")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(session.ID, SessionPrefix))
	if err != nil || len(decoded) != 32 {
		t.Fatal("identity did not preserve full digest")
	}
	if session.Provider != "terminal/codex" || session.Status != "idle" || session.Loaded == nil || *session.Loaded || session.Model != "" || session.Preview != "" || !reflect.DeepEqual(session.Capabilities, []protocol.ActionType{protocol.ActionRead}) {
		t.Fatalf("unexpected read-only telemetry: %+v", session)
	}
	public, err := json.Marshal(session)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(public), host.socket) || strings.Contains(string(public), "private-transcript") {
		t.Fatal("public metadata leaked private binding")
	}
	if !reflect.DeepEqual(host.methods(), []string{"ping", "agent.get"}) {
		t.Fatal("state discovery read pane body")
	}
	output, err := observer.ReadSession(context.Background(), session.ID)
	if err != nil || !strings.Contains(output, "终端快照") || !strings.Contains(output, "非完整对话") || !strings.Contains(output, "裁剪提示") || !strings.Contains(output, "safe terminal text") {
		t.Fatalf("read: %v %q", err, output)
	}
	if !reflect.DeepEqual(host.methods(), []string{"ping", "agent.get", "ping", "agent.get", "pane.read", "agent.get"}) {
		t.Fatal("read RPC order")
	}
}

func TestDiscoveryStatusMappingAndMissingAgents(t *testing.T) {
	cases := []struct{ status, expected string }{{"working", "active"}, {"idle", "idle"}, {"done", "idle"}, {"blocked", "blocked"}, {"unknown", "unknown"}}
	for _, tc := range cases {
		t.Run(tc.status, func(t *testing.T) {
			host := newTestHost(t, func(request testRequest, _, _ int) []byte {
				result := normalResult(t, request)
				if request.Method == "agent.get" {
					result["agent"].(map[string]any)["agent_status"] = tc.status
				}
				return encodedResponse(t, request, result)
			})
			sessions, err := NewObserver(host.socket, []string{"w1:p1"}).DiscoverSessions(context.Background())
			if err != nil || len(sessions) != 1 || sessions[0].Status != tc.expected {
				t.Fatalf("status count=%d err=%v", len(sessions), err)
			}
		})
	}
	for _, missing := range []string{"provider", "session"} {
		t.Run("missing-"+missing, func(t *testing.T) {
			host := newTestHost(t, func(request testRequest, _, _ int) []byte {
				result := normalResult(t, request)
				if request.Method == "agent.get" {
					if missing == "provider" {
						result["agent"].(map[string]any)["agent"] = nil
					} else {
						delete(result["agent"].(map[string]any), "agent_session")
					}
				}
				return encodedResponse(t, request, result)
			})
			sessions, err := NewObserver(host.socket, []string{"w1:p1"}).DiscoverSessions(context.Background())
			if err != nil || len(sessions) != 0 {
				t.Fatalf("missing agent count=%d err=%v", len(sessions), err)
			}
		})
	}
}

func TestInputsAndUnknownSessionNeverConnect(t *testing.T) {
	host := newTestHost(t, func(request testRequest, _, _ int) []byte {
		return encodedResponse(t, request, normalResult(t, request))
	})
	tooMany := make([]string, MaxPanes+1)
	for i := range tooMany {
		tooMany[i] = fmt.Sprintf("w1:p%d", i)
	}
	cases := []struct {
		socket string
		panes  []string
	}{{"", []string{"w1:p1"}}, {"relative.sock", []string{"w1:p1"}}, {host.socket, nil}, {host.socket, tooMany}, {host.socket, []string{"focus"}}, {host.socket, []string{"w1:p1", "w1:p1"}}, {host.socket, []string{" w1:p1"}}, {host.socket + "\x00", []string{"w1:p1"}}}
	for _, tc := range cases {
		if _, err := NewObserver(tc.socket, tc.panes).DiscoverSessions(context.Background()); err == nil {
			t.Fatal("invalid configuration accepted")
		}
	}
	observer := NewObserver(host.socket, []string{"w1:p1"})
	for _, id := range []string{"", "codex-thread", SessionPrefix + strings.Repeat("a", 43)} {
		if _, err := observer.ReadSession(context.Background(), id); err == nil {
			t.Fatal("undiscovered session read")
		}
	}
	if len(host.methods()) != 0 {
		t.Fatal("invalid input contacted host")
	}
}

func TestIdentityReplacementAndRevisionBounds(t *testing.T) {
	cases := []struct {
		name   string
		phase  string
		mutate func(map[string]any)
	}{
		{"before-terminal", "before", func(a map[string]any) { a["terminal_id"] = "replacement" }},
		{"before-session", "before", func(a map[string]any) { a["agent_session"].(map[string]any)["value"] = "replacement" }},
		{"before-provider", "before", func(a map[string]any) { a["agent"] = "claude" }},
		{"before-workspace", "before", func(a map[string]any) { a["workspace_id"] = "w2" }},
		{"after-terminal", "after", func(a map[string]any) { a["terminal_id"] = "replacement" }},
		{"after-session", "after", func(a map[string]any) { a["agent_session"].(map[string]any)["kind"] = "id" }},
		{"after-tab", "after", func(a map[string]any) { a["tab_id"] = "tab2" }},
		{"after-regression", "after", func(a map[string]any) { a["revision"] = 9 }},
		{"snapshot-old", "read", func(a map[string]any) { a["revision"] = 9 }},
		{"snapshot-future", "read", func(a map[string]any) { a["revision"] = 11 }},
		{"snapshot-pane", "read", func(a map[string]any) { a["pane_id"] = "w1:p2" }},
		{"snapshot-workspace", "read", func(a map[string]any) { a["workspace_id"] = "w2" }},
		{"snapshot-tab", "read", func(a map[string]any) { a["tab_id"] = "tab2" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			host := newTestHost(t, func(request testRequest, connection, index int) []byte {
				result := normalResult(t, request)
				if connection == 2 && ((tc.phase == "before" && index == 2) || (tc.phase == "after" && index == 4)) {
					tc.mutate(result["agent"].(map[string]any))
				}
				if connection == 2 && tc.phase == "read" && index == 3 {
					tc.mutate(result["read"].(map[string]any))
				}
				return encodedResponse(t, request, result)
			})
			observer := NewObserver(host.socket, []string{"w1:p1"})
			sessions, err := observer.DiscoverSessions(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			output, err := observer.ReadSession(context.Background(), sessions[0].ID)
			if err == nil || output != "" {
				t.Fatal("mismatched snapshot was returned")
			}
			if tc.phase == "before" {
				for _, method := range host.methods() {
					if method == "pane.read" {
						t.Fatal("read body after replacement")
					}
				}
			}
		})
	}
}

func TestValidRevisionIntervalAndSnapshotCropping(t *testing.T) {
	for _, kind := range []string{"interval", "host-truncated", "bytes", "lines"} {
		t.Run(kind, func(t *testing.T) {
			host := newTestHost(t, func(request testRequest, connection, index int) []byte {
				result := normalResult(t, request)
				if connection == 2 && request.Method == "pane.read" {
					read := result["read"].(map[string]any)
					read["revision"] = 11
					switch kind {
					case "host-truncated":
						read["truncated"] = true
					case "bytes":
						read["text"] = strings.Repeat("界", MaxSnapshotBytes)
					case "lines":
						read["text"] = strings.Repeat("old\n", SnapshotLines) + "newest"
					}
				}
				if connection == 2 && index == 4 {
					result["agent"].(map[string]any)["revision"] = 12
				}
				return encodedResponse(t, request, result)
			})
			observer := NewObserver(host.socket, []string{"w1:p1"})
			sessions, err := observer.DiscoverSessions(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			output, err := observer.ReadSession(context.Background(), sessions[0].ID)
			if err != nil || !utf8.ValidString(output) || len(output) > MaxSnapshotBytes+512 {
				t.Fatalf("bounded snapshot failed: %v size=%d", err, len(output))
			}
			if kind != "interval" && !strings.Contains(output, "已裁剪") {
				t.Fatal("cropping was hidden")
			}
			if kind == "lines" && !strings.HasSuffix(output, "newest") {
				t.Fatal("not the recent text")
			}
		})
	}
}

func TestRediscoveryChangesIDAndRetiresBinding(t *testing.T) {
	for _, changedField := range []string{"terminal_id", "workspace_id", "tab_id"} {
		t.Run(changedField, func(t *testing.T) {
			host := newTestHost(t, func(request testRequest, connection, _ int) []byte {
				result := normalResult(t, request)
				if connection > 1 && request.Method == "agent.get" {
					result["agent"].(map[string]any)[changedField] = "new-identity"
				}
				return encodedResponse(t, request, result)
			})
			observer := NewObserver(host.socket, []string{"w1:p1"})
			first, err := observer.DiscoverSessions(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			second, err := observer.DiscoverSessions(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if first[0].ID == second[0].ID {
				t.Fatal("replacement did not change public identity")
			}
			before := len(host.methods())
			if _, err := observer.ReadSession(context.Background(), first[0].ID); err == nil {
				t.Fatal("retired binding read")
			}
			if len(host.methods()) != before {
				t.Fatal("retired binding contacted host")
			}
		})
	}
}
