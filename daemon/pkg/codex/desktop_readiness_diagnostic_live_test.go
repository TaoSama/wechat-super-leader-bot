package codex

import (
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

const desktopReadinessDiagnosticTimeout = 8 * time.Second

// Explicit opt-in against an existing owner only. Request UUIDs correlate IPC
// reads; no ClientUserMessageID/dispatch RequestID, journal claim, PrepareSend,
// Dispatch, start-turn or resume operation is created. Logs contain no raw
// errors, identities, socket paths, model settings, input or recorded bodies.
func TestLiveCodexDesktopReadonlyReadinessDiagnostic(t *testing.T) {
	if os.Getenv("LIVE_CODEX_DESKTOP_READINESS_DIAGNOSTIC") != "1" {
		t.Skip("requires explicit readonly readiness diagnostic opt-in")
	}
	path, sessionID := os.Getenv("LIVE_CODEX_DESKTOP_SOCKET"), os.Getenv("LIVE_CODEX_DESKTOP_SESSION")
	expected := os.Getenv("LIVE_CODEX_DESKTOP_READINESS_EXPECTED")
	if path == "" || !protocol.ValidHistoryIdentity(sessionID) || !protocol.ValidTurnID(sessionID) ||
		(expected != "ready" && expected != "busy") {
		t.Fatal("invalid explicit socket/session/expected selection; no connection attempted")
	}
	ctx, cancel := context.WithTimeout(context.Background(), desktopReadinessDiagnosticTimeout)
	defer cancel()
	err := diagnoseDesktopReadonlyReadiness(ctx, NewDesktopController(path), sessionID, t)
	if err == nil {
		err = ctx.Err()
	}
	ready, busy := err == nil, errors.Is(err, ErrDesktopSendBusy)
	t.Logf("stage=outcome ready=%t busy=%t classification=%s", ready, busy, readinessDiagnosticError(err))
	if (expected == "ready" && !ready) || (expected == "busy" && !busy) {
		t.Fatal("readonly readiness did not match explicit expected classification")
	}
}

func diagnoseDesktopReadonlyReadiness(ctx context.Context, controller *DesktopController, sessionID string, t *testing.T) error {
	t.Helper()
	started := time.Now()
	p, err := controller.prepareConnection(ctx, sessionID)
	if err != nil {
		t.Logf("stage=connect-discovery error=%s elapsed_ms=%d", readinessDiagnosticError(err), time.Since(started).Milliseconds())
		return err
	}
	defer func() { p.Close(); t.Log("stage=close completed=true") }()
	t.Logf("stage=connect-discovery owner_valid=true elapsed_ms=%d", time.Since(started).Milliseconds())
	requestID, err := protocol.NewDispatchID() // IPC request correlation only, not a dispatch identity.
	if err != nil {
		t.Log("stage=settings-request correlation_valid=false")
		return err
	}
	response, _, err := p.targeted(ctx, desktopReadSettings, 1, requestID, map[string]string{"conversationId": sessionID})
	if err != nil {
		t.Logf("stage=settings-response error=%s elapsed_ms=%d", readinessDiagnosticError(err), time.Since(started).Milliseconds())
		return err
	}
	var result struct {
		Settings *desktopControlSettings `json:"settings"`
	}
	if json.Unmarshal(response.Result, &result) != nil {
		t.Log("stage=settings-decode valid=false")
		return errors.New("invalid readiness diagnostic settings JSON")
	}
	if result.Settings == nil {
		t.Log("stage=settings-gates present=false")
		return errors.New("desktop thread is not an ordinary resumed user thread")
	}
	settings := result.Settings
	t.Logf("stage=settings-gates present=true resume_resumed=%t mode_default=%t thread_source_present=%t ordinary_resumed=%t elapsed_ms=%d",
		settings.ResumeState == "resumed", settings.Mode == "default", settings.ThreadSource != nil, settings.ordinaryResumed(), time.Since(started).Milliseconds())
	if !settings.ordinaryResumed() {
		return errors.New("desktop thread is not an ordinary resumed user thread")
	}
	state, err := p.snapshot(ctx)
	if err != nil {
		t.Logf("stage=snapshot error=%s elapsed_ms=%d", readinessDiagnosticError(err), time.Since(started).Milliseconds())
		return err
	}
	t.Logf("stage=snapshot-gates ordinary_resumed=%t start_kind_default=%t runtime_idle=%t active_flags=%d requests_present=%t requests=%d unconfirmed=%d turns_present=%t transient_turns=%d canonical_present=%t elapsed_ms=%d",
		state.ordinaryResumed(), state.ThreadStartKind == "default", state.ThreadRuntimeStatus.Type == "idle", len(state.ThreadRuntimeStatus.ActiveFlags),
		state.Requests != nil, len(state.Requests), len(state.UnconfirmedTurnSubmissions), state.Turns != nil, len(state.Turns), state.TurnHistory != nil, time.Since(started).Milliseconds())
	turns, historyErr := state.recordedTurns()
	if historyErr != nil {
		t.Logf("stage=recorded-turns error=%s", readinessDiagnosticError(historyErr))
	} else {
		nonterminal := 0
		for _, turn := range turns {
			if turn.Status != "completed" && turn.Status != "failed" && turn.Status != "interrupted" {
				nonterminal++
			}
		}
		t.Logf("stage=recorded-turns count=%d nonterminal=%d", len(turns), nonterminal)
	}
	err = state.readyToSend()
	t.Logf("stage=ready-to-send ready=%t busy=%t error=%s elapsed_ms=%d", err == nil, errors.Is(err, ErrDesktopSendBusy), readinessDiagnosticError(err), time.Since(started).Milliseconds())
	return err
}

func readinessDiagnosticError(err error) string {
	if err == nil {
		return "none"
	}
	var networkError net.Error
	switch {
	case errors.Is(err, ErrDesktopSendBusy):
		return "busy-or-runtime-unknown"
	case errors.Is(err, errDesktopControlStateLimit):
		return "structural-limit"
	case errors.Is(err, errDesktopControlStateJSON):
		return "invalid-state-json"
	case errors.Is(err, errDesktopFrameTooLarge):
		return "frame-limit"
	case errors.Is(err, context.DeadlineExceeded):
		return "total-deadline"
	case errors.As(err, &networkError) && networkError.Timeout():
		return "transport-timeout"
	case errors.Is(err, context.Canceled), errors.Is(err, net.ErrClosed):
		return "canceled-or-closed"
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		return "eof"
	case errors.Is(err, errDesktopUnavailable):
		return "owner-response-unavailable"
	case errors.Is(err, errDesktopCanonicalDuplicateReference):
		return "canonical-duplicate-reference"
	}
	switch err.Error() {
	case "desktop thread is not an ordinary resumed user thread", "unsupported desktop thread kind or resume state":
		return "ordinary-resumed-gate"
	case "desktop snapshot owner or version mismatch":
		return "snapshot-owner-version"
	case "desktop snapshot recipient mismatch":
		return "snapshot-recipient"
	case "desktop snapshot target mismatch", "invalid desktop snapshot identity or revision":
		return "snapshot-target-revision"
	case "desktop snapshot revision regressed":
		return "snapshot-revision-regressed"
	case "desktop snapshot noise limit exceeded":
		return "snapshot-noise-limit"
	case "desktop turns missing", "unknown desktop history shape", "invalid canonical desktop history", "canonical history entries missing", "canonical history entity missing":
		return "recorded-history-shape"
	case "invalid readiness diagnostic settings JSON":
		return "settings-json"
	default:
		return "other-rejected"
	}
}

func TestDesktopReadonlyReadinessDiagnosticFixtures(t *testing.T) {
	for _, busy := range []bool{false, true} {
		t.Run(map[bool]string{false: "ready", true: "busy"}[busy], func(t *testing.T) {
			path := desktopFixture(t, func(c *desktopConn) error {
				if err := controlHandshake(c); err != nil {
					return err
				}
				state := controlState()
				if busy {
					state["requests"] = []any{map[string]string{"method": "approval"}}
				}
				if err := controlPreflight(c, state, nil); err != nil {
					return err
				}
				return controlExpectClosed(c) // A dispatch/resume/additional request fails this fixture.
			})
			ctx, cancel := context.WithTimeout(context.Background(), desktopReadinessDiagnosticTimeout)
			defer cancel()
			err := diagnoseDesktopReadonlyReadiness(ctx, NewDesktopController(path), "session", t)
			if errors.Is(err, ErrDesktopSendBusy) != busy || (err == nil) == busy {
				t.Fatal("readonly fixture readiness classification mismatch")
			}
		})
	}
	if readinessDiagnosticError(errors.New("private-fixture-body")) != "other-rejected" {
		t.Fatal("unknown diagnostic error escaped fixed classification")
	}
}
