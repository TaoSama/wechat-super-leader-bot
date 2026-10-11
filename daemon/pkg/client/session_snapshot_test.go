package client

import (
	"reflect"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestSessionsChangedIgnoresOnlyObservationAndOrdering(t *testing.T) {
	loaded := true
	base := protocol.Session{ID: "one", Provider: "codex", Title: "title", Cwd: "/fixture", Status: "idle",
		Capabilities: []protocol.ActionType{protocol.ActionSend, protocol.ActionRead}, ObservedAt: "old",
		Model: "model", ModelProvider: "provider", ReasoningEffort: "high", UpdatedAt: "updated", Preview: "preview", Loaded: &loaded}
	for _, tc := range []struct {
		name   string
		change func(*protocol.Session)
	}{
		{"id", func(s *protocol.Session) { s.ID = "two" }},
		{"provider", func(s *protocol.Session) { s.Provider = "other" }},
		{"title", func(s *protocol.Session) { s.Title = "other" }},
		{"cwd", func(s *protocol.Session) { s.Cwd = "/other" }},
		{"status", func(s *protocol.Session) { s.Status = "busy" }},
		{"capabilities", func(s *protocol.Session) { s.Capabilities = []protocol.ActionType{protocol.ActionRead} }},
		{"model", func(s *protocol.Session) { s.Model = "other" }},
		{"model-provider", func(s *protocol.Session) { s.ModelProvider = "other" }},
		{"reasoning", func(s *protocol.Session) { s.ReasoningEffort = "low" }},
		{"updated", func(s *protocol.Session) { s.UpdatedAt = "other" }},
		{"preview", func(s *protocol.Session) { s.Preview = "other" }},
		{"loaded-false", func(s *protocol.Session) { value := false; s.Loaded = &value }},
		{"loaded-unknown", func(s *protocol.Session) { s.Loaded = nil }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			changed := cloneSessions([]protocol.Session{base})
			tc.change(&changed[0])
			if !sessionsChanged([]protocol.Session{base}, changed) {
				t.Fatal("metadata change not detected")
			}
		})
	}
	previous := cloneSessions([]protocol.Session{base, {ID: "two"}})
	original := cloneSessions(previous)
	current := cloneSessions([]protocol.Session{previous[1], previous[0]})
	current[1].ObservedAt = "new"
	current[1].Capabilities = []protocol.ActionType{protocol.ActionRead, protocol.ActionSend}
	if sessionsChanged(previous, current) {
		t.Fatal("observation/order triggered update")
	}
	if !reflect.DeepEqual(previous, original) {
		t.Fatal("comparison mutated input")
	}
	if sessionsChanged(nil, []protocol.Session{}) || sessionsChanged([]protocol.Session{{ID: "one"}}, []protocol.Session{{ID: "one", Capabilities: []protocol.ActionType{}}}) {
		t.Fatal("nil/empty representation triggered update")
	}
	if !sessionsChanged(previous, previous[:1]) || !sessionsChanged(previous[:1], previous) {
		t.Fatal("collection change not detected")
	}
	copy := cloneSessions(previous)
	copy[0].Capabilities[0] = protocol.ActionRead
	*copy[0].Loaded = false
	if !reflect.DeepEqual(previous, original) {
		t.Fatal("cache clone aliases mutable fields")
	}
}
