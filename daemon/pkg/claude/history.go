package claude

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/transcript"
)

const (
	// The shared transcript reader keys roots by agent and checks this source.
	transcriptAgent  = "claude"
	transcriptSource = "herdr:" + transcriptAgent
	readSessionItems = 20
)

func historyRef(id string) transcript.Ref {
	return transcript.Ref{Source: transcriptSource, Agent: transcriptAgent, Kind: "id", Value: id}
}

// ReadHistory returns a bounded page of recorded user and assistant text. It
// never starts the CLI and never reports send authority.
func (a *Adapter) ReadHistory(ctx context.Context, publicID, generation, cursor string, limit int) (protocol.SessionHistory, string, error) {
	id, ok := nativeID(publicID)
	if !ok {
		return protocol.SessionHistory{}, "", errors.New(protocol.HistoryUnavailable)
	}
	info, err := a.locate(id)
	if err != nil {
		return protocol.SessionHistory{}, "", errors.New(protocol.HistoryUnavailable)
	}
	page, next, err := a.history.Read(ctx, historyRef(id), generation, cursor, limit)
	if err != nil {
		return protocol.SessionHistory{}, "", err
	}
	loaded := false
	now := a.now().UTC().Format(time.RFC3339Nano)
	return protocol.SessionHistory{
		Source: protocol.HistorySourceClaude,
		Session: protocol.Session{ID: publicID, Provider: ProviderClaudeCode, Title: info.Title, Cwd: info.Cwd, Status: StatusUnknown,
			Capabilities: []protocol.ActionType{protocol.ActionRead}, Loaded: &loaded, ObservedAt: now},
		Items: page.Items, NextCursor: page.NextCursor, Truncated: page.Truncated, FetchedAt: now,
	}, next, nil
}

// Reset expires every history generation.
func (a *Adapter) Reset() { a.history.Reset() }

// ReadSession renders the most recent recorded messages as plain text.
func (a *Adapter) ReadSession(ctx context.Context, publicID string) (string, error) {
	history, _, err := a.ReadHistory(ctx, publicID, "", "", readSessionItems)
	if err != nil {
		return "", err
	}
	var builder strings.Builder
	builder.WriteString("Claude Code session " + publicID + " (" + history.Session.Cwd + ")\n")
	for _, item := range history.Items {
		builder.WriteString("\n[" + item.Kind + "] " + item.Text + "\n")
	}
	return builder.String(), nil
}
