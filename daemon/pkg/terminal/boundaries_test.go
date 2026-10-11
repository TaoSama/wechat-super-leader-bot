package terminal

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

func TestMissingResultAgentAndWrongTypeFail(t *testing.T) {
	for _, mode := range []string{"missing", "null", "wrong-type"} {
		t.Run(mode, func(t *testing.T) {
			host := newTestHost(t, func(r testRequest, _, _ int) []byte {
				result := normalResult(t, r)
				if r.Method == "agent.get" {
					switch mode {
					case "missing":
						delete(result, "agent")
					case "null":
						result["agent"] = nil
					case "wrong-type":
						result["type"] = "agent_prompted"
					}
				}
				return encodedResponse(t, r, result)
			})
			if sessions, err := NewObserver(host.socket, []string{"w1:p1"}).DiscoverSessions(context.Background()); err == nil || sessions != nil {
				t.Fatal("missing result object accepted")
			}
		})
	}
}

func TestMetadataPrecedenceBoundsAndNoModelGuess(t *testing.T) {
	cases := []struct{ name, title, stripped, foreground, cwd, wantTitle, wantCwd string }{
		{"preferred", "gpt-anything task", "second", "/foreground", "/cwd", "gpt-anything task", "/foreground"},
		{"fallback", "bad\x1btitle", "clean title", "bad\x7fcwd", "/cwd", "clean title", "/cwd"},
		{"all-invalid", "bad\ntext", "bad\u0085text", "bad\x00path", "", "终端 w1:p1", ""},
		{"bounded", strings.Repeat("界", MaxTitleBytes), "", "/foreground", "", "", "/foreground"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			host := newTestHost(t, func(r testRequest, _, _ int) []byte {
				result := normalResult(t, r)
				if r.Method == "agent.get" {
					a := result["agent"].(map[string]any)
					a["title"] = tc.title
					a["terminal_title_stripped"] = tc.stripped
					a["terminal_title"] = "\x1b[31mMUST_NOT_USE"
					a["foreground_cwd"] = tc.foreground
					a["cwd"] = tc.cwd
				}
				return encodedResponse(t, r, result)
			})
			sessions, err := NewObserver(host.socket, []string{"w1:p1"}).DiscoverSessions(context.Background())
			if err != nil || len(sessions) != 1 {
				t.Fatalf("metadata discovery: %v", err)
			}
			s := sessions[0]
			if tc.wantTitle != "" && s.Title != tc.wantTitle {
				t.Fatal("title precedence mismatch")
			}
			if s.Cwd != tc.wantCwd || len(s.Title) > MaxTitleBytes || !utf8.ValidString(s.Title) || s.Model != "" || s.ModelProvider != "" || s.ReasoningEffort != "" || strings.Contains(s.Title, "MUST_NOT_USE") {
				t.Fatal("metadata limits or model isolation failed")
			}
		})
	}
}

func TestPartialDiscoveryDoesNotPublishBindings(t *testing.T) {
	host := newTestHost(t, func(r testRequest, _, index int) []byte {
		result := normalResult(t, r)
		if index == 3 {
			result["agent"].(map[string]any)["revision"] = -1
		}
		return encodedResponse(t, r, result)
	})
	observer := NewObserver(host.socket, []string{"w1:p1", "w1:p2"})
	if sessions, err := observer.DiscoverSessions(context.Background()); err == nil || sessions != nil {
		t.Fatal("partial discovery escaped")
	}
	observer.mu.Lock()
	count := len(observer.bindings)
	observer.mu.Unlock()
	if count != 0 {
		t.Fatal("failed scan published a readable binding")
	}
}

func TestAllTupleIdentitiesAffectPublicID(t *testing.T) {
	observer := NewObserver("/explicit/socket", []string{"w1:p1"})
	original := binding{Pane: "w1:p1", Terminal: "t", Workspace: "w1", Tab: "tab", Provider: "terminal/codex", Session: &agentSession{Source: "source", Agent: "codex", Kind: "id", Value: "session"}}
	first, err := observer.publicID(original)
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"socket", "pane", "terminal", "workspace", "tab", "provider", "session-source", "session-agent", "session-kind", "session-value"} {
		t.Run(field, func(t *testing.T) {
			candidate := original
			session := *original.Session
			candidate.Session = &session
			o := NewObserver(observer.socket, observer.panes)
			switch field {
			case "socket":
				o.socket = "/another/socket"
			case "pane":
				candidate.Pane = "w1:p2"
			case "terminal":
				candidate.Terminal = "new"
			case "workspace":
				candidate.Workspace = "w2"
			case "tab":
				candidate.Tab = "new"
			case "provider":
				candidate.Provider = "terminal/claude"
			case "session-source":
				session.Source = "new"
			case "session-agent":
				session.Agent = "claude"
			case "session-kind":
				session.Kind = "path"
			case "session-value":
				session.Value = "new"
			}
			id, err := o.publicID(candidate)
			if err != nil || id == first {
				t.Fatal("tuple field did not bind identity")
			}
		})
	}
}

func TestConcurrentReadsAndRefreshAreRaceSafe(t *testing.T) {
	host := newTestHost(t, func(r testRequest, _, _ int) []byte { return encodedResponse(t, r, normalResult(t, r)) })
	observer := NewObserver(host.socket, []string{"w1:p1"})
	sessions, err := observer.DiscoverSessions(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			if index%2 == 0 {
				if _, err := observer.DiscoverSessions(context.Background()); err != nil {
					t.Error(err)
				}
			} else {
				if _, err := observer.ReadSession(context.Background(), sessions[0].ID); err != nil {
					t.Error(err)
				}
			}
		}(i)
	}
	wg.Wait()
}

func TestCanceledContextAndControlPathsNeverConnect(t *testing.T) {
	host := newTestHost(t, func(r testRequest, _, _ int) []byte { return encodedResponse(t, r, normalResult(t, r)) })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := NewObserver(host.socket, []string{"w0:p0"}).DiscoverSessions(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("pre-canceled: %v", err)
	}
	for _, control := range []string{"\x1b", "\x7f", "\u0085", "\xff"} {
		if _, err := NewObserver(host.socket+control, []string{"w1:p1"}).DiscoverSessions(context.Background()); err == nil {
			t.Fatal("control socket path accepted")
		}
	}
	if len(host.methods()) != 0 {
		t.Fatal("invalid or canceled input contacted host")
	}
}

func TestUnterminatedFrameTimesOut(t *testing.T) {
	host := newTestHost(t, func(r testRequest, _, _ int) []byte { return []byte(`{"id":"PRIVATE_TOKEN"}`) })
	observer := NewObserver(host.socket, []string{"w1:p1"})
	observer.rpcTimeout = 30 * time.Millisecond
	if _, err := observer.DiscoverSessions(context.Background()); !errors.Is(err, context.DeadlineExceeded) || strings.Contains(err.Error(), "PRIVATE_TOKEN") {
		t.Fatalf("unterminated frame: %v", err)
	}
}

func TestValidateSelectorsIsSharedPureAndRejectsDisabledPair(t *testing.T) {
	if err := ValidateSelectors("/explicit/space socket.sock", []string{"w0:p0", "w1:p2"}); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		socket string
		panes  []string
	}{
		{"", nil}, {"", []string{"w1:p1"}}, {"/explicit.sock", nil}, {"relative.sock", []string{"w1:p1"}},
		{"/explicit.sock\xff", []string{"w1:p1"}}, {"/explicit.sock\ufffd", []string{"w1:p1"}}, {"/explicit.sock\x1b", []string{"w1:p1"}},
		{"/explicit.sock ", []string{"w1:p1"}}, {"/" + strings.Repeat("x", MaxIdentityBytes), []string{"w1:p1"}},
		{"/explicit.sock", []string{"focus"}}, {"/explicit.sock", []string{"w1:p1", "w1:p1"}},
		{"/explicit.sock", []string{"w1:p" + strings.Repeat("1", MaxIdentityBytes)}},
	}
	for i, tc := range cases {
		if err := ValidateSelectors(tc.socket, tc.panes); err == nil {
			t.Fatalf("invalid selectors %d accepted", i)
		}
	}
}
