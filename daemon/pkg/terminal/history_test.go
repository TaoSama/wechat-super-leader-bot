package terminal

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/transcript"
)

const historyTestID = "11111111-1111-4111-8111-111111111111"

func historyTestRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	path := filepath.Join(root, "rollout-2026-10-12T01-02-03-"+historyTestID+".jsonl")
	content := `{"type":"session_meta","payload":{"id":"` + historyTestID + `","source":"cli"}}` + "\n" + `{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"public answer"}]}}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	return root
}

func historyAgent(pane, status string, revision uint64) map[string]any {
	agent := agentResult(pane, status, revision)
	agent["agent_session"] = map[string]any{"source": "herdr:codex", "agent": "codex", "kind": "id", "value": historyTestID}
	return agent
}

func TestHistoryReaderReadOnlyAndObservedState(t *testing.T) {
	root := historyTestRoot(t)
	host := newTestHost(t, func(request testRequest, connection, index int) []byte {
		if request.Method == "ping" {
			return encodedResponse(t, request, pongResult())
		}
		if request.Method != "agent.get" {
			t.Error("history made a non-identity RPC")
		}
		revision := uint64(10)
		if connection == 2 && index == 3 {
			revision = 11
		}
		return encodedResponse(t, request, map[string]any{"type": "agent_info", "agent": historyAgent("w1:p1", "working", revision)})
	})
	observer := NewObserver(host.socket, []string{"w1:p1"})
	sessions, err := observer.DiscoverSessions(context.Background())
	if err != nil || len(sessions) != 1 {
		t.Fatalf("discovery: %v", err)
	}
	reader := NewHistoryReader(observer, transcript.New(transcript.Config{Roots: map[string]string{"codex": root}}))
	priorMethods := host.methods()
	if !reader.Supports(sessions[0].ID) || reader.Supports("native-id") {
		t.Fatal("route eligibility mismatch")
	}
	if !reflect.DeepEqual(priorMethods, host.methods()) {
		t.Fatal("Supports performed I/O")
	}
	history, generation, err := reader.ReadHistory(context.Background(), sessions[0].ID, "", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if history.Source != protocol.HistorySourceTerminal || history.Session.HistorySource != history.Source || generation == "" || len(history.Items) != 1 || history.Items[0].Text != "public answer" {
		t.Fatalf("history: %+v", history)
	}
	if history.Session.ID != sessions[0].ID || history.Session.Status != "active" || history.Session.Loaded == nil || *history.Session.Loaded || !reflect.DeepEqual(history.Session.Capabilities, []protocol.ActionType{protocol.ActionRead}) {
		t.Fatalf("observation/send state changed: %+v", history.Session)
	}
	if !reflect.DeepEqual(host.methods(), []string{"ping", "agent.get", "ping", "agent.get", "agent.get"}) {
		t.Fatalf("unexpected methods: %v", host.methods())
	}
	reader.Reset()
	_, _, err = reader.ReadHistory(context.Background(), sessions[0].ID, generation, "", 1)
	if err == nil || err.Error() != protocol.HistoryContextExpired {
		t.Fatalf("reset: %v", err)
	}
}

func TestHistoryReaderFrozenIdentity(t *testing.T) {
	for _, mutation := range []string{"before-terminal", "after-session", "after-pane", "after-provider", "revision-backwards", "discovery-revoked", "reset"} {
		t.Run(mutation, func(t *testing.T) {
			root := historyTestRoot(t)
			var observer *Observer
			var reader *HistoryReader
			host := newTestHost(t, func(request testRequest, connection, index int) []byte {
				if request.Method == "ping" {
					return encodedResponse(t, request, pongResult())
				}
				agent := historyAgent("w1:p1", "blocked", 10)
				if connection == 2 {
					if mutation == "before-terminal" {
						agent["terminal_id"] = "terminal-2"
					}
					if index == 3 {
						switch mutation {
						case "after-session":
							agent["agent_session"].(map[string]any)["value"] = "22222222-2222-4222-8222-222222222222"
						case "after-pane":
							agent["tab_id"] = "tab-2"
						case "after-provider":
							agent["agent"] = "grok"
							agent["agent_session"] = map[string]any{"source": "herdr:grok", "agent": "grok", "kind": "id", "value": "new-session"}
						case "revision-backwards":
							agent["revision"] = uint64(9)
						case "discovery-revoked":
							observer.mu.Lock()
							observer.bindings = map[string]binding{}
							observer.mu.Unlock()
						case "reset":
							reader.Reset()
						}
					}
				}
				return encodedResponse(t, request, map[string]any{"type": "agent_info", "agent": agent})
			})
			observer = NewObserver(host.socket, []string{"w1:p1"})
			sessions, err := observer.DiscoverSessions(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			reader = NewHistoryReader(observer, transcript.New(transcript.Config{Roots: map[string]string{"codex": root}}))
			history, generation, err := reader.ReadHistory(context.Background(), sessions[0].ID, "", "", 10)
			if err == nil || err.Error() != protocol.HistoryContextExpired || len(history.Items) != 0 || generation != "" {
				t.Fatalf("changed identity published: %+v %q %v", history, generation, err)
			}
			for _, method := range host.methods() {
				if method != "ping" && method != "agent.get" {
					t.Fatalf("non-read method: %s", method)
				}
			}
		})
	}
}

func TestHistoryReaderUnsupportedBindingDoesNotReadSocket(t *testing.T) {
	host := newTestHost(t, func(request testRequest, connection, index int) []byte {
		return encodedResponse(t, request, normalResult(t, request))
	})
	observer := NewObserver(host.socket, []string{"w1:p1"})
	sessions, err := observer.DiscoverSessions(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	reader := NewHistoryReader(observer, transcript.New(transcript.Config{Roots: map[string]string{"codex": historyTestRoot(t)}}))
	before := host.methods()
	if reader.Supports(sessions[0].ID) {
		t.Fatal("path binding supported")
	}
	_, _, err = reader.ReadHistory(context.Background(), sessions[0].ID, "", "", 1)
	if err == nil || err.Error() != protocol.HistoryUnavailable {
		t.Fatalf("unsupported binding: %v", err)
	}
	if !reflect.DeepEqual(before, host.methods()) {
		t.Fatal("unsupported binding touched socket")
	}
}
