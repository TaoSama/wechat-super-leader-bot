package terminal

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

type agentSession struct {
	Source string `json:"source"`
	Agent  string `json:"agent"`
	Kind   string `json:"kind"`
	Value  string `json:"value"`
}

type agentInfo struct {
	Pane                   string            `json:"pane_id"`
	Terminal               string            `json:"terminal_id"`
	Workspace              string            `json:"workspace_id"`
	Tab                    string            `json:"tab_id"`
	Agent                  *string           `json:"agent"`
	Status                 string            `json:"agent_status"`
	Revision               *uint64           `json:"revision"`
	Session                *agentSession     `json:"agent_session,omitempty"`
	Focused                *bool             `json:"focused"`
	Cwd                    *string           `json:"cwd"`
	DisplayAgent           *string           `json:"display_agent"`
	ForegroundCwd          *string           `json:"foreground_cwd"`
	Name                   *string           `json:"name"`
	TerminalTitle          *string           `json:"terminal_title"`
	TerminalTitleStripped  *string           `json:"terminal_title_stripped"`
	Title                  *string           `json:"title"`
	InteractiveReady       json.RawMessage   `json:"interactive_ready"`
	LaunchPending          json.RawMessage   `json:"launch_pending"`
	ScreenDetectionSkipped json.RawMessage   `json:"screen_detection_skipped"`
	StateChangeSeq         json.RawMessage   `json:"state_change_seq"`
	StateLabels            map[string]string `json:"state_labels"`
	Tokens                 map[string]string `json:"tokens"`
}

func (a *agentInfo) binding() binding {
	return binding{Pane: a.Pane, Terminal: a.Terminal, Workspace: a.Workspace, Tab: a.Tab,
		Provider: "terminal/" + *a.Agent, Session: a.Session}
}

func (a *agentInfo) publicTitle() string {
	for _, field := range []*string{a.Title, a.TerminalTitleStripped} {
		if field == nil || !validIdentity(*field) {
			continue
		}
		title := *field
		if len(title) > MaxTitleBytes {
			title = title[:MaxTitleBytes]
			for !utf8.ValidString(title) {
				title = title[:len(title)-1]
			}
		}
		return title
	}
	return "终端 " + a.Pane
}

func (a *agentInfo) publicCwd() string {
	for _, field := range []*string{a.ForegroundCwd, a.Cwd} {
		if field != nil && validIdentity(*field) {
			return *field
		}
	}
	return ""
}

func (c *rpcClient) getAgent(pane string) (*agentInfo, error) {
	return c.getAgentContext(c.ctx, pane)
}

func (c *rpcClient) getAgentContext(ctx context.Context, pane string) (*agentInfo, error) {
	var response struct {
		Type  string     `json:"type"`
		Agent *agentInfo `json:"agent"`
	}
	if err := c.callContext(ctx, "agent.get", struct {
		Target string `json:"target"`
	}{pane}, &response); err != nil {
		return nil, err
	}
	if response.Type != "agent_info" {
		return nil, errors.New("terminal agent result type mismatch")
	}
	if response.Agent == nil {
		return nil, errors.New("terminal agent result object is missing")
	}
	return validateAgentInfo(response.Agent, pane)
}

func validateAgentInfo(a *agentInfo, pane string) (*agentInfo, error) {
	if a == nil {
		return nil, errors.New("terminal agent result object is missing")
	}
	if a.Pane != pane || !validIdentity(a.Terminal) || !validIdentity(a.Workspace) || !validIdentity(a.Tab) ||
		!validIdentity(a.Status) || a.Revision == nil || a.Focused == nil || !a.validOptionalFields() {
		return nil, errors.New("terminal agent identity or status is invalid")
	}
	if a.Status != "idle" && a.Status != "working" && a.Status != "blocked" && a.Status != "done" && a.Status != "unknown" {
		return nil, errors.New("terminal agent status is invalid")
	}
	if a.Agent != nil && !validIdentity(*a.Agent) {
		return nil, errors.New("terminal agent provider is invalid")
	}
	if a.Session != nil && (!validIdentity(a.Session.Source) || !validIdentity(a.Session.Agent) ||
		!validIdentity(a.Session.Value) || (a.Session.Kind != "id" && a.Session.Kind != "path")) {
		return nil, errors.New("terminal agent session binding is invalid")
	}
	if a.Agent == nil || a.Session == nil {
		return nil, nil
	}
	if a.Session.Agent != *a.Agent {
		return nil, errors.New("terminal agent provider binding mismatch")
	}
	return a, nil
}

var tokenKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)

const maxTokenEntries = 32

func validOptionalBool(raw json.RawMessage) bool {
	return raw == nil || bytes.Equal(bytes.TrimSpace(raw), []byte("true")) || bytes.Equal(bytes.TrimSpace(raw), []byte("false"))
}

func (a *agentInfo) validOptionalFields() bool {
	for _, raw := range []json.RawMessage{a.InteractiveReady, a.LaunchPending, a.ScreenDetectionSkipped} {
		if !validOptionalBool(raw) {
			return false
		}
	}
	if a.StateChangeSeq != nil {
		var sequence *uint64
		if json.Unmarshal(a.StateChangeSeq, &sequence) != nil || sequence == nil {
			return false
		}
	}
	if len(a.Tokens) > maxTokenEntries {
		return false
	}
	for key := range a.Tokens {
		if !tokenKeyPattern.MatchString(key) {
			return false
		}
	}
	return true
}

type paneSnapshot struct {
	Pane      string  `json:"pane_id"`
	Workspace string  `json:"workspace_id"`
	Tab       string  `json:"tab_id"`
	Source    string  `json:"source"`
	Format    string  `json:"format"`
	Text      *string `json:"text"`
	Revision  *uint64 `json:"revision"`
	Truncated *bool   `json:"truncated"`
}

func (c *rpcClient) readPane(pane string) (*paneSnapshot, error) {
	var response struct {
		Type string        `json:"type"`
		Read *paneSnapshot `json:"read"`
	}
	params := struct {
		Pane      string `json:"pane_id"`
		Source    string `json:"source"`
		Format    string `json:"format"`
		StripANSI bool   `json:"strip_ansi"`
		Lines     int    `json:"lines"`
	}{pane, readSource, readFormat, true, SnapshotLines}
	if err := c.call("pane.read", params, &response); err != nil {
		return nil, err
	}
	s := response.Read
	if response.Type != "pane_read" || s == nil || s.Pane != pane || !validIdentity(s.Workspace) || !validIdentity(s.Tab) ||
		s.Source != readSource || s.Format != readFormat || s.Revision == nil || s.Truncated == nil || s.Text == nil {
		return nil, errors.New("terminal snapshot schema or identity mismatch")
	}
	if strings.IndexFunc(*s.Text, func(r rune) bool { return unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' }) >= 0 {
		return nil, errors.New("terminal snapshot contains unstripped control characters")
	}
	return s, nil
}
