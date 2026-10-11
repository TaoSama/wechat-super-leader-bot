package codex

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const desktopHistoryDiagnosticTimeout = 8 * time.Second

// Explicit opt-in, existing owner only. The production history stream may only
// initialize, discover, read settings, follow and load the recorded history.
// No message bodies, identities, socket paths or unfiltered errors are logged.
func TestLiveCodexDesktopReadonlyHistoryDiagnostic(t *testing.T) {
	path, sessionID := os.Getenv("LIVE_CODEX_DESKTOP_SOCKET"), os.Getenv("LIVE_CODEX_DESKTOP_SESSION")
	if os.Getenv("LIVE_CODEX_DESKTOP_HISTORY_DIAGNOSTIC") != "1" || path == "" || sessionID == "" {
		t.Skip("requires explicit socket, session and LIVE_CODEX_DESKTOP_HISTORY_DIAGNOSTIC=1")
	}
	if !protocol.ValidHistoryIdentity(sessionID) || !protocol.ValidTurnID(sessionID) {
		t.Fatal("diagnostic invalid target identity; no connection attempted")
	}
	ctx, cancel := context.WithTimeout(context.Background(), desktopHistoryDiagnosticTimeout)
	defer cancel()
	deadline, ok := ctx.Deadline()
	if !ok {
		t.Fatal("diagnostic missing total deadline")
	}
	connection, cleanup, err := connectDesktopClient(ctx, path, desktopHistoryClient)
	if err != nil {
		t.Fatalf("stage=initialize method=initialize type=unknown version=0 error=%s", historyDiagnosticError(err))
	}
	t.Log("stage=initialize method=initialize type=response version=0 identity_valid=true")
	entry := &desktopHistoryEntry{sessionID: sessionID, generation: "diagnostic-local-context", ctx: ctx,
		changed: make(chan struct{}), active: 1, cursors: map[string]desktopHistoryAnchor{},
		anchorTokens: map[desktopHistoryAnchor]string{}}
	stream := &desktopHistoryStream{entry: entry, connection: connection, operationTimeout: desktopOwnerTimeout}
	defer func() {
		if stream.owner != "" {
			if err := connection.SetWriteDeadline(time.Now().Add(desktopUnsubscribeTimeout)); err != nil {
				t.Errorf("stage=unfollow deadline_error=%s", historyDiagnosticError(err))
			} else if err := connection.follow(stream.owner, sessionID, false); err != nil {
				t.Errorf("stage=unfollow method=thread-stream-following-changed type=broadcast version=1 error=%s", historyDiagnosticError(err))
			} else {
				t.Log("stage=unfollow method=thread-stream-following-changed type=broadcast version=1 attempted=true")
			}
		}
		cleanup()
		t.Log("stage=close completed=true")
	}()
	if err := stream.request(desktopDiscoverOwner, 1, ""); err != nil {
		t.Fatalf("stage=discovery method=thread-owner-discovery type=request version=1 error=%s", historyDiagnosticError(err))
	}
	for {
		stage := historyDiagnosticStage(stream)
		readDeadline := deadline
		if !stream.deadline.IsZero() && stream.deadline.Before(readDeadline) {
			readDeadline = stream.deadline
		}
		if err := connection.SetReadDeadline(readDeadline); err != nil {
			t.Fatalf("stage=%s read_deadline_error=%s", stage, historyDiagnosticError(err))
		}
		message, err := connection.readWithLimit(desktopHistoryRawLimit)
		if err != nil {
			t.Fatalf("stage=%s method=%s type=unknown error=%s noise=%d ready=%t complete=%t items=%d",
				stage, historyDiagnosticMethod(stream.method), historyDiagnosticError(err), stream.noise,
				entry.ready, entry.view.complete, len(entry.view.items))
		}
		beforeRevision, beforeGeneration, beforeReady := entry.revision, entry.view.canonicalGeneration, entry.ready
		beforeMethod := stream.method
		requestMatch := stream.requestID != "" && message.RequestID == stream.requestID
		err = stream.handle(message)
		ownerMatch := stream.owner != "" && ((message.Type == "response" && message.HandledByClientID == stream.owner) ||
			(message.Type == "broadcast" && message.SourceClientID == stream.owner))
		targetMatch := message.TargetClientID == connection.clientID
		for _, target := range message.TargetClientIDs {
			targetMatch = targetMatch || target == connection.clientID
		}
		t.Logf("stage=%s method=%s type=%s version=%d owner_known=%t owner_match=%t target_match=%t request_id_match=%t request_method_match=%t revision_changed=%t generation_changed=%t ready_before=%t ready_after=%t complete=%t items=%d noise=%d error=%s",
			stage, historyDiagnosticMethod(message.Method), historyDiagnosticType(message.Type), message.Version,
			stream.owner != "", ownerMatch, targetMatch, requestMatch, message.Method == beforeMethod,
			beforeRevision != entry.revision, beforeGeneration != entry.view.canonicalGeneration, beforeReady,
			entry.ready, entry.view.complete, len(entry.view.items), stream.noise, historyDiagnosticError(err))
		if err != nil {
			if message.Method == desktopStateChanged {
				historyDiagnosticCandidate(t, entry, message)
			}
			t.Fatalf("stage=%s production_history_gate_error=%s", stage, historyDiagnosticError(err))
		}
		if err := stream.maybeLoad(); err != nil {
			t.Fatalf("stage=load-complete method=thread-follower-load-complete-history type=request version=1 error=%s", historyDiagnosticError(err))
		}
		loadReady := !entry.loadRequested || (entry.loadResponded && entry.revision >= entry.loadRevision)
		if entry.ready && loadReady && entry.view.complete {
			history, err := entry.pageLocked("", protocol.DefaultHistoryLimit)
			if err != nil {
				t.Fatalf("stage=page error=%s", historyDiagnosticError(err))
			}
			t.Logf("stage=page complete=true items=%d page_items=%d load_requested=%t load_responded=%t generation_present=%t; no bodies or identities logged",
				len(entry.view.items), len(history.Items), entry.loadRequested, entry.loadResponded, entry.generation != "")
			return
		}
		if !time.Now().Before(deadline) {
			t.Fatal("stage=total-deadline error=timeout")
		}
	}
}

func historyDiagnosticStage(stream *desktopHistoryStream) string {
	switch stream.method {
	case desktopDiscoverOwner:
		return "discovery"
	case desktopReadSettings:
		return "settings"
	case desktopLoadCompleteHistory:
		return "load-complete"
	default:
		return "follow-stream"
	}
}

func historyDiagnosticMethod(method string) string {
	switch method {
	case desktopInitialize, desktopDiscoverOwner, desktopReadSettings, desktopFollowingChanged, desktopStateChanged, desktopLoadCompleteHistory:
		return method
	default:
		return "other"
	}
}

func historyDiagnosticType(kind string) string {
	switch kind {
	case "request", "response", "broadcast":
		return kind
	default:
		return "other"
	}
}

func historyDiagnosticError(err error) string {
	if err == nil {
		return "none"
	}
	var networkError net.Error
	switch {
	case errors.Is(err, errDesktopFrameTooLarge):
		return "frame-too-large"
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &networkError) && networkError.Timeout():
		return "timeout"
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		return "eof"
	case errors.Is(err, net.ErrClosed), errors.Is(err, context.Canceled):
		return "closed"
	}
	switch err.Error() {
	case protocol.HistoryContextExpired:
		return "history-context-expired"
	case protocol.HistoryFailed:
		return "history-failed"
	case protocol.HistoryUnavailable:
		return "history-unavailable"
	case protocol.HistoryTooLarge:
		return "history-too-large"
	case protocol.HistoryIncomplete:
		return "history-incomplete"
	case protocol.HistoryTimeout:
		return "history-timeout"
	default:
		return "other"
	}
}

// Inspect a rejected candidate without committing it or weakening any gate.
// All decoding, patching and projection reuse production size/safety limits.
func historyDiagnosticCandidate(t *testing.T, entry *desktopHistoryEntry, message desktopEnvelope) {
	t.Helper()
	var params map[string]any
	if json.Unmarshal(message.Params, &params) != nil {
		t.Log("candidate_params_valid=false")
		return
	}
	change, err := historyObject(params["change"])
	if err != nil {
		t.Logf("candidate_change_valid=false error=%s", historyDiagnosticError(err))
		return
	}
	revision, revisionValid := historyRevision(change["revision"])
	base, baseValid := historyRevision(change["baseRevision"])
	kind := "other"
	var encoded []byte
	var state map[string]any
	switch change["type"] {
	case "snapshot":
		kind = "snapshot"
		encoded, err = json.Marshal(change["conversationState"])
		if err == nil {
			state, err = decodeDesktopHistoryState(encoded)
		}
	case "patches":
		kind = "patches"
		var patches []desktopPatch
		patches, err = historyPatches(change["patches"])
		if err == nil {
			encoded, state, err = applyDesktopHistoryPatches(entry.raw, patches)
		}
		if err == nil {
			encoded, err = json.Marshal(state)
		}
	default:
		err = historyError(protocol.HistoryFailed)
	}
	t.Logf("candidate_change=%s target_session_match=%t target_host_match=%t revision_valid=%t revision_changed=%t revision_regressed=%t base_valid=%t base_matches=%t same_revision_content_matches=%t decode_error=%s",
		kind, params["conversationId"] == entry.sessionID, params["hostId"] == "local", revisionValid,
		revisionValid && revision != entry.revision, revisionValid && revision < entry.revision, baseValid,
		baseValid && base == entry.revision, revisionValid && revision == entry.revision && bytes.Equal(encoded, entry.raw), historyDiagnosticError(err))
	if err != nil {
		return
	}
	view, err := projectDesktopHistory(state, entry.sessionID)
	prefixMatch := len(view.items) >= len(entry.order)
	if prefixMatch {
		for index, anchor := range entry.order {
			item := view.items[index]
			prefixMatch = prefixMatch && item.TurnID == anchor.turnID && item.ID == anchor.itemID
		}
	}
	t.Logf("candidate_projection_error=%s generation_known=%t generation_changed=%t complete=%t items=%d committed_items=%d prefix_matches=%t",
		historyDiagnosticError(err), view.canonicalGeneration != "", entry.ready && entry.view.canonicalGeneration != view.canonicalGeneration,
		view.complete, len(view.items), len(entry.view.items), prefixMatch)
}
