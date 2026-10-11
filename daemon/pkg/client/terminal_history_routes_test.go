package client

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type terminalHistoryFixture struct {
	routedDesktopFixture
	supported string
	afterRead func()
}

func (f *terminalHistoryFixture) Supports(id string) bool { return id == f.supported }

func (f *terminalHistoryFixture) ReadHistory(ctx context.Context, id, generation, cursor string, limit int) (protocol.SessionHistory, string, error) {
	page, next, err := f.routedDesktopFixture.ReadHistory(ctx, id, generation, cursor, limit)
	if f.afterRead != nil {
		f.afterRead()
	}
	return page, next, err
}

func TestTerminalHistoryPinsSourceWithoutNativeFallbackOrControlFacts(t *testing.T) {
	id := "terminal:" + base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	raw := "private-file-boundary"
	loaded := false
	original := protocol.Session{ID: id, Provider: "terminal/codex", Status: "active", Loaded: &loaded,
		Capabilities: []protocol.ActionType{protocol.ActionRead}, ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), HistorySource: protocol.HistorySourceTerminal}
	a := &historyFixture{}
	d := NewDaemon(&config.Config{NodeID: "node"}, a)
	f := &terminalHistoryFixture{routedDesktopFixture: routedDesktopFixture{history: protocol.SessionHistory{
		Session: protocol.Session{ID: id, Status: "idle"}, Items: []protocol.HistoryItem{{ID: "item", Kind: "assistant", Type: "message", Text: "visible"}}, NextCursor: &raw}, generation: "file-generation"}, supported: id}
	d.terminalHistory, d.terminalSnapshot = f, []protocol.Session{original}
	msg := routedHistoryRequest()
	msg.SessionID = id
	first := requireHistory(t, d, msg)
	if first.Source != protocol.HistorySourceTerminal || first.Session.Status != "active" || first.Session.Loaded == nil || *first.Session.Loaded ||
		first.Session.SendAvailability != nil || len(first.Session.Capabilities) != 1 || first.Items[0].TurnID != "" || *first.NextCursor == raw || a.called.Load() != 0 {
		t.Fatalf("history changed authority, leaked cursor or called native: %+v", first)
	}
	msg.HistoryContext, msg.Cursor = first.HistoryContext, *first.NextCursor
	_ = requireHistory(t, d, msg)
	if f.seenGeneration != "file-generation" || f.seenCursor != raw {
		t.Fatal("terminal paging lost generation or cursor")
	}
	f.err = errors.New(protocol.HistoryContextExpired)
	if got := d.ReadHistory(context.Background(), msg); got.Error != protocol.HistoryContextExpired || a.called.Load() != 0 {
		t.Fatalf("terminal failure fell back: %+v", got)
	}
	d.resetHistory()
	if f.resets != 1 || d.ReadHistory(context.Background(), msg).Error != protocol.HistoryContextExpired {
		t.Fatal("disconnect did not invalidate file history context")
	}
	d.terminalHistory = nil
	msg.HistoryContext, msg.Cursor = "", ""
	if got := d.ReadHistory(context.Background(), msg); got.Error != protocol.HistoryUnavailable || a.called.Load() != 0 {
		t.Fatal("disabled terminal history reached another source")
	}
}

func TestTerminalHistoryMarkerIsServerDerivedAndRevokedOnFailure(t *testing.T) {
	id := "terminal:" + base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	session := protocol.Session{ID: id, Provider: "terminal/codex", Status: "idle", HistorySource: protocol.HistorySourceTerminal, ObservedAt: "unchanged"}
	d := NewDaemon(&config.Config{NodeID: "node"}, &historyFixture{})
	d.terminalObserver = &catalogFixture{discover: func(context.Context) ([]protocol.Session, error) { return []protocol.Session{session}, nil }}
	items, err := d.discoverTerminal(context.Background())
	if err != nil || items[0].HistorySource != "" {
		t.Fatalf("unconfigured observer injected a history route: %+v %v", items, err)
	}
	d.terminalHistory = &terminalHistoryFixture{supported: id}
	items, err = d.discoverTerminal(context.Background())
	if err != nil || items[0].HistorySource != protocol.HistorySourceTerminal {
		t.Fatal("configured binding did not advertise route")
	}
	d.terminalSnapshot = items
	d.invalidateTerminal(make(chan struct{}, 1))
	if d.terminalSnapshot[0].HistorySource != "" || d.terminalSnapshot[0].ObservedAt != "unchanged" || d.terminalSnapshot[0].Status != "unknown" {
		t.Fatal("failed discovery kept route or rewrote freshness")
	}
}

func TestTerminalHistoryRevocationBeforeAndDuringReadExpiresContext(t *testing.T) {
	id := "terminal:" + base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	for _, during := range []bool{false, true} {
		d := NewDaemon(&config.Config{NodeID: "node"}, &historyFixture{})
		session := protocol.Session{ID: id, Provider: "terminal/codex", HistorySource: protocol.HistorySourceTerminal}
		f := &terminalHistoryFixture{routedDesktopFixture: routedDesktopFixture{history: protocol.SessionHistory{Session: session}, generation: "file-generation"}, supported: id}
		d.terminalHistory, d.terminalSnapshot = f, []protocol.Session{session}
		msg := routedHistoryRequest()
		msg.SessionID = id
		first := requireHistory(t, d, msg)
		msg.HistoryContext = first.HistoryContext
		revoke := func() { d.invalidateTerminal(make(chan struct{}, 1)) }
		if during {
			f.afterRead = revoke
		} else {
			revoke()
		}
		if got := d.ReadHistory(context.Background(), msg); got.Error != protocol.HistoryContextExpired || got.History != nil {
			t.Fatalf("revoked history published (during=%v): %+v", during, got)
		}
		f.afterRead = nil
		d.terminalSnapshot[0].HistorySource = protocol.HistorySourceTerminal
		if got := d.ReadHistory(context.Background(), msg); got.Error != protocol.HistoryContextExpired {
			t.Fatal("restored marker revived an expired context")
		}
		msg.HistoryContext = ""
		if next := requireHistory(t, d, msg); next.HistoryContext == first.HistoryContext {
			t.Fatal("explicit reset reused the invalidated context")
		}
	}
}

func TestOpenDaemonRejectsInvalidHistoryBeforeJournalEffects(t *testing.T) {
	root := t.TempDir()
	d, err := OpenDaemon(&config.Config{NodeID: "node", TerminalSocketPath: "/fixture/terminal.sock", TerminalPanes: []string{"w2:p3"},
		TerminalHistoryRoots: map[string]string{"codex": "relative"}, StateDir: filepath.Join(root, "journal")}, &historyFixture{})
	if err == nil || d != nil {
		t.Fatalf("invalid history config accepted: %v", err)
	}
	entries, readErr := os.ReadDir(root)
	if readErr != nil || len(entries) != 0 {
		t.Fatalf("invalid config produced journal side effects: %v", readErr)
	}
}
