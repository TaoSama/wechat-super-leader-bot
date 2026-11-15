package desktop

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"strings"
	"testing"
	"time"
)

const subscriptionDiagnosticSecret = "private-token-owner-session-message-body"

func captureDesktopSubscriptionLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	writer, flags, prefix := log.Writer(), log.Flags(), log.Prefix()
	var output bytes.Buffer
	log.SetOutput(&output)
	log.SetFlags(0)
	log.SetPrefix("")
	t.Cleanup(func() {
		log.SetOutput(writer)
		log.SetFlags(flags)
		log.SetPrefix(prefix)
	})
	return &output
}

func assertDesktopSubscriptionLog(t *testing.T, output string, reason, stage, class string, cleanup bool) {
	t.Helper()
	want := fmt.Sprintf("desktop target subscription unavailable: %s stage=%s class=%s cleanup_failed=%t\n", reason, stage, class, cleanup)
	if output != want || strings.Contains(output, subscriptionDiagnosticSecret) {
		t.Fatalf("unexpected subscription diagnostic: got %q, want %q", output, want)
	}
}

type subscriptionDiagnosticTimeout struct{}

func (subscriptionDiagnosticTimeout) Error() string   { return subscriptionDiagnosticSecret }
func (subscriptionDiagnosticTimeout) Timeout() bool   { return true }
func (subscriptionDiagnosticTimeout) Temporary() bool { return false }

type subscriptionDiagnosticConn struct {
	*desktopFramePolicyConn
	readErr, resetErr error
}

func (c *subscriptionDiagnosticConn) Read(data []byte) (int, error) {
	n, err := c.desktopFramePolicyConn.Read(data)
	if n == 0 && errors.Is(err, io.EOF) && c.readErr != nil {
		return 0, c.readErr
	}
	return n, err
}

func (c *subscriptionDiagnosticConn) SetReadDeadline(deadline time.Time) error {
	if deadline.IsZero() {
		return c.resetErr
	}
	return nil
}

func subscriptionDiagnosticFrame(body string, extra int) []byte {
	var header [4]byte
	binary.LittleEndian.PutUint32(header[:], uint32(len(body)+extra))
	return append(header[:], []byte(body)...)
}

func TestDesktopSubscriptionDiagnosticsFromFrameFailures(t *testing.T) {
	timeout := &net.OpError{Op: "read", Net: "unix", Err: subscriptionDiagnosticTimeout{}}
	cleanupErr := fmt.Errorf("%s: %w", subscriptionDiagnosticSecret, context.DeadlineExceeded)
	var oversized [4]byte
	binary.LittleEndian.PutUint32(oversized[:], desktopSubscriptionFrameLimit+1)
	for _, tc := range []struct {
		name, stage, class, reason string
		frame                      []byte
		readErr, resetErr, wantErr error
	}{
		{name: "EOF", stage: "read-header", class: "eof", wantErr: io.EOF},
		{name: "short header", frame: []byte{1, 0}, stage: "read-header", class: "truncated-frame", wantErr: io.ErrUnexpectedEOF},
		{name: "oversized header", frame: oversized[:], stage: "read-header", class: "frame-limit", reason: "frame-too-large", wantErr: errDesktopFrameTooLarge},
		{name: "short body", frame: subscriptionDiagnosticFrame("{", 1), stage: "read-body-project-json", class: "truncated-frame", wantErr: io.ErrUnexpectedEOF},
		{name: "JSON", frame: subscriptionDiagnosticFrame("[]", 0), stage: "read-body-project-json", class: "invalid-json", wantErr: errDesktopSubscriptionJSON},
		{name: "JSON depth bound", frame: subscriptionDiagnosticFrame(`{"ignored":`+strings.Repeat("[", 140)+"0"+strings.Repeat("]", 140)+"}", 0), stage: "read-body-project-json", class: "json-bound", wantErr: errDesktopSubscriptionJSONBounds},
		{name: "transport timeout", readErr: timeout, stage: "read-header", class: "transport-timeout", wantErr: timeout},
		{name: "transport closed", readErr: net.ErrClosed, stage: "read-header", class: "transport-closed", wantErr: net.ErrClosed},
		{name: "private unclassified cause", readErr: errors.New(subscriptionDiagnosticSecret), stage: "read-header", class: "other-rejected"},
		{name: "body failure and cleanup deadline", frame: subscriptionDiagnosticFrame("[]", 0), resetErr: cleanupErr, stage: "read-body-project-json", class: "invalid-json", reason: "subscription-window-ended", wantErr: errDesktopSubscriptionJSON},
		{name: "cleanup only", frame: subscriptionDiagnosticFrame("{}", 0), resetErr: errors.New(subscriptionDiagnosticSecret), stage: "cleanup-read-deadline", class: "other-rejected"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			output := captureDesktopSubscriptionLogs(t)
			conn := &subscriptionDiagnosticConn{desktopFramePolicyConn: &desktopFramePolicyConn{reader: bytes.NewReader(tc.frame)}, readErr: tc.readErr, resetErr: tc.resetErr}
			budget := newDesktopFrameBudget(1, time.Second)
			err := (&desktopConn{Conn: conn}).readBudgeted(context.Background(), budget, func(desktopEnvelope) error { return nil })
			if err == nil || len(budget.slots) != 0 || tc.wantErr != nil && !errors.Is(err, tc.wantErr) || tc.resetErr != nil && !errors.Is(err, tc.resetErr) {
				t.Fatalf("diagnostic changed frame failure or permit release: %v", err)
			}
			if tc.readErr == timeout {
				var operation *net.OpError
				if !errors.As(err, &operation) || operation != timeout {
					t.Fatal("diagnostic wrapper lost the transport error type")
				}
			}
			logDesktopSubscriptionFailure(err)
			reason := tc.reason
			if reason == "" {
				reason = "invalid-state-or-transport"
			}
			assertDesktopSubscriptionLog(t, output.String(), reason, tc.stage, tc.class, tc.resetErr != nil)
		})
	}
}

func TestDesktopSubscriptionDiagnosticsJoinedPrimaryAndCleanup(t *testing.T) {
	conn := &desktopConn{Conn: &desktopFramePolicyConn{reader: bytes.NewReader(nil)}}
	primary := conn.readBudgeted(context.Background(), newDesktopFrameBudget(1, time.Second), func(desktopEnvelope) error { return nil })
	cleanup := desktopSubscriptionAt(desktopSubscriptionStageUnfollow, errors.New(subscriptionDiagnosticSecret))
	for _, tc := range []struct {
		name, stage, class string
		err                error
	}{
		{"wrapped primary then cleanup", "read-header", "eof", fmt.Errorf("%s: %w", subscriptionDiagnosticSecret, errors.Join(primary, cleanup))},
		{"cleanup then primary", "read-header", "eof", errors.Join(cleanup, primary)},
		{"unmarked primary then cleanup", "attempt", "eof", errors.Join(fmt.Errorf("%s: %w", subscriptionDiagnosticSecret, io.EOF), cleanup)},
		{"two primary branches", "read-header", "eof", errors.Join(primary, desktopSubscriptionAt(desktopSubscriptionStageBody, errDesktopSubscriptionJSON), cleanup)},
		{"wrapped join inside stage", "read-body-project-json", "eof", desktopSubscriptionAt(desktopSubscriptionStageBody, fmt.Errorf("%s: %w", subscriptionDiagnosticSecret, errors.Join(io.EOF, errors.New(subscriptionDiagnosticSecret))))},
		{"cleanup only", "cleanup-unfollow", "other-rejected", cleanup},
	} {
		t.Run(tc.name, func(t *testing.T) {
			output := captureDesktopSubscriptionLogs(t)
			logDesktopSubscriptionFailure(tc.err)
			if tc.class == "eof" && !errors.Is(tc.err, io.EOF) {
				t.Fatal("primary identity was lost")
			}
			assertDesktopSubscriptionLog(t, output.String(), "invalid-state-or-transport", tc.stage, tc.class, tc.name != "wrapped join inside stage")
		})
	}
	t.Run("unmarked error fallback", func(t *testing.T) {
		output := captureDesktopSubscriptionLogs(t)
		logDesktopSubscriptionFailure(fmt.Errorf("wrapped: %w", errors.New(subscriptionDiagnosticSecret)))
		assertDesktopSubscriptionLog(t, output.String(), "invalid-state-or-transport", "attempt", "other-rejected", false)
	})
	t.Run("no failure", func(t *testing.T) {
		output := captureDesktopSubscriptionLogs(t)
		logDesktopSubscriptionFailure(nil)
		if output.Len() != 0 {
			t.Fatal("nil error emitted a failure")
		}
	})
}
