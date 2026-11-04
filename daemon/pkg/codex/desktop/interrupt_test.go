package desktop

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"sync/atomic"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
)

const interruptFixtureTurn = "running-turn"

func TestDesktopInterruptExactTurnAndClassification(t *testing.T) {
	for _, tc := range []struct {
		name      string
		reply     any
		failure   bool
		wantError bool
		uncertain bool
	}{
		{name: "confirmed", reply: map[string]any{"interruptedTurnId": interruptFixtureTurn, "ok": true}},
		{name: "owner-declined", reply: map[string]any{"interruptedTurnId": nil, "ok": false}, wantError: true},
		{name: "mismatched-turn", reply: map[string]any{"interruptedTurnId": "other-turn", "ok": true}, wantError: true, uncertain: true},
		{name: "missing-ok", reply: map[string]any{"interruptedTurnId": interruptFixtureTurn}, wantError: true, uncertain: true},
		{name: "non-success-response", failure: true, wantError: true, uncertain: true},
		{name: "lost-response", wantError: true, uncertain: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var writes atomic.Int32
			path := desktopFixture(t, func(c *desktopConn) error {
				if err := controlHandshake(c); err != nil {
					return err
				}
				request, err := c.read()
				if err != nil {
					return err
				}
				var params map[string]any
				if err := json.Unmarshal(request.Params, &params); err != nil {
					return err
				}
				want := map[string]any{"conversationId": "session", "mode": "user-stop", "expectedTurnId": interruptFixtureTurn}
				if request.Type != "request" || request.Method != desktopInterruptTurn || request.Version != 4 ||
					request.TargetClientID != "owner" || request.SourceClientID != "control-client" || !reflect.DeepEqual(params, want) {
					return fmt.Errorf("wrong exact desktop interrupt: %+v %v", request, params)
				}
				writes.Add(1)
				switch {
				case tc.failure:
					if err := c.write(desktopEnvelope{Type: "response", RequestID: request.RequestID, Method: request.Method,
						ResultType: "error", HandledByClientID: "owner"}); err != nil {
						return err
					}
				case tc.reply == nil:
					return nil
				default:
					if err := desktopReply(c, request, "owner", tc.reply); err != nil {
						return err
					}
				}
				return controlExpectClosed(c)
			})
			ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
			defer cancel()
			err := NewDesktopController(path).InterruptTurn(ctx, "session", interruptFixtureTurn)
			if (err != nil) != tc.wantError || codex.IsUncertain(err) != tc.uncertain {
				t.Fatalf("error=%v wantError=%t uncertain=%t", err, tc.wantError, tc.uncertain)
			}
			if writes.Load() != 1 {
				t.Fatalf("interrupt writes = %d, want exactly one", writes.Load())
			}
		})
	}
}

func TestDesktopInterruptRejectsInvalidIdentityWithoutConnecting(t *testing.T) {
	controller := NewDesktopController("/tmp/desktop-interrupt-never-dialed.sock")
	for _, turn := range []string{"", "bad turn"} {
		if err := controller.InterruptTurn(context.Background(), "session", turn); err == nil || codex.IsUncertain(err) {
			t.Fatalf("turn %q error = %v", turn, err)
		}
	}
}
