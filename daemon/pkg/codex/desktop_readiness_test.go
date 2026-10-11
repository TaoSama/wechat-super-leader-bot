package codex

import (
	"context"
	"errors"
	"testing"
)

func TestDesktopReadinessUsesFullPreflightWithoutDispatch(t *testing.T) {
	for _, tc := range []struct {
		name    string
		edit    func(map[string]any)
		wantErr bool
		busy    bool
	}{
		{"ready", func(map[string]any) {}, false, false},
		{"approval", func(s map[string]any) { s["requests"] = []any{map[string]string{"method": "approval"}} }, true, true},
		{"unconfirmed", func(s map[string]any) { s["unconfirmedTurnSubmissions"] = []any{map[string]bool{"pending": true}} }, true, true},
		{"missing-requests", func(s map[string]any) { delete(s, "requests") }, true, true},
		{"unsupported-thread", func(s map[string]any) { s["mode"] = "aeon" }, true, false},
		{"missing-history", func(s map[string]any) { delete(s, "turns") }, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := desktopFixture(t, func(c *desktopConn) error {
				if err := controlHandshake(c); err != nil {
					return err
				}
				state := controlState()
				tc.edit(state)
				if err := controlPreflight(c, state, nil); err != nil {
					return err
				}
				return controlExpectClosed(c)
			})
			ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
			defer cancel()
			err := NewDesktopController(path).CheckSendReadiness(ctx, "session")
			if (err != nil) != tc.wantErr || errors.Is(err, ErrDesktopSendBusy) != tc.busy {
				t.Fatalf("readiness error=%v wantError=%t busy=%t", err, tc.wantErr, tc.busy)
			}
		})
	}
}

func TestDesktopReadinessRejectsInvalidIdentityAndWrongOwner(t *testing.T) {
	if err := NewDesktopController("/does-not-connect").CheckSendReadiness(context.Background(), ""); err == nil {
		t.Fatal("invalid identity accepted")
	}
	path := desktopFixture(t, func(c *desktopConn) error {
		if err := controlHandshake(c); err != nil {
			return err
		}
		request, err := c.read()
		if err != nil {
			return err
		}
		if err := desktopReply(c, request, "other-owner", map[string]any{"settings": map[string]string{"mode": "default", "threadSource": "user", "resumeState": "resumed"}}); err != nil {
			return err
		}
		return controlExpectClosed(c)
	})
	ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
	defer cancel()
	if err := NewDesktopController(path).CheckSendReadiness(ctx, "session"); err == nil {
		t.Fatal("another owner's settings granted readiness")
	}
}
