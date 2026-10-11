package codex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestDesktopControlStateNodeBoundaryAndUnknownFields(t *testing.T) {
	// The root object and the padding array contribute two nodes.
	for _, extra := range []int{0, 1} {
		count := desktopControlNodeLimit - 2 + extra
		raw := []byte(`{"padding":[` + strings.Repeat("1,", count-1) + `1]}`)
		state, err := decodeDesktopControlState(raw)
		if extra == 0 && (err != nil || state == nil) {
			t.Fatalf("exact node boundary rejected: %v", err)
		}
		if extra != 0 && (!errors.Is(err, errDesktopControlStateLimit) || state != nil) {
			t.Fatalf("unknown field bypassed node boundary: %v", err)
		}
	}
}

func TestDesktopControlStateObjectAndArrayHaveSameNodeBudget(t *testing.T) {
	for _, extra := range []int{0, 1} {
		for _, object := range []bool{false, true} {
			var raw strings.Builder
			if object {
				raw.WriteByte('{')
			} else {
				raw.WriteByte('[')
			}
			for index := range desktopControlNodeLimit - 1 + extra {
				if index > 0 {
					raw.WriteByte(',')
				}
				if object {
					fmt.Fprintf(&raw, `"%d":`, index)
				}
				raw.WriteByte('1')
			}
			if object {
				raw.WriteByte('}')
			} else {
				raw.WriteByte(']')
			}
			err := validateDesktopControlState([]byte(raw.String()))
			if extra == 0 && err != nil || extra != 0 && !errors.Is(err, errDesktopControlStateLimit) {
				t.Fatalf("object=%t extra=%d node boundary differs: %v", object, extra, err)
			}
		}
	}
}

func TestDesktopControlStateDepthBoundary(t *testing.T) {
	for _, depth := range []int{desktopControlDepthLimit, desktopControlDepthLimit + 1} {
		raw := []byte(`{"padding":` + strings.Repeat("[", depth-1) + `0` + strings.Repeat("]", depth-1) + `}`)
		state, err := decodeDesktopControlState(raw)
		if depth == desktopControlDepthLimit && (err != nil || state == nil) {
			t.Fatalf("exact depth boundary rejected: %v", err)
		}
		if depth > desktopControlDepthLimit && (!errors.Is(err, errDesktopControlStateLimit) || state != nil) {
			t.Fatalf("deep state expanded: %v", err)
		}
	}
}

func TestDesktopControlStateDenseItemsRejectedBeforeTypedDecode(t *testing.T) {
	// The typed decoder would fail on requests before reaching dense items.
	// A structural-limit error proves that scanning preceded that decoder.
	raw := []byte(`{"requests":"PRIVATE","turns":[{"turnId":"target","status":"completed","items":[` +
		strings.Repeat("1,", desktopControlNodeLimit) + `1]}]}`)
	if len(raw) >= desktopInboundFrameLimit {
		t.Fatal("dense fixture must fit the inbound byte boundary")
	}
	state, err := decodeDesktopControlState(raw)
	if state != nil || !errors.Is(err, errDesktopControlStateLimit) || strings.Contains(err.Error(), "PRIVATE") {
		t.Fatalf("dense state expanded before validation: %v", err)
	}
}

func TestDesktopControlStateInvalidInputUsesStaticErrors(t *testing.T) {
	for _, raw := range []string{"", "null", `{} {}`, `{"requests":"PRIVATE"}`, `{"padding":"PRIVATE"`} {
		state, err := decodeDesktopControlState([]byte(raw))
		if state != nil || !errors.Is(err, errDesktopControlStateJSON) || strings.Contains(err.Error(), "PRIVATE") {
			t.Fatalf("invalid state leaked input or decoded: %v", err)
		}
	}
	if state, err := decodeDesktopControlState(make([]byte, desktopInboundFrameLimit+1)); state != nil || !errors.Is(err, errDesktopControlStateLimit) {
		t.Fatalf("oversized state decoded: %v", err)
	}
}

func TestDesktopControlStateUnknownNumbersRemainStructural(t *testing.T) {
	if state, err := decodeDesktopControlState([]byte(`{"future":1e1000}`)); state == nil || err != nil {
		t.Fatalf("valid unknown numeric value rejected by structural guard: %v", err)
	}
	for _, raw := range []string{`{"future":1e}`, `{"turns":[{"items":[1e1000]}]}`} {
		if state, err := decodeDesktopControlState([]byte(raw)); state != nil || !errors.Is(err, errDesktopControlStateJSON) {
			t.Fatalf("invalid syntax or known typed numeric value accepted: %v", err)
		}
	}
}

func TestDesktopControlDenseSnapshotsFailBeforeDispatchAndReleaseSlot(t *testing.T) {
	for _, operation := range []string{"readiness", "prepare", "inspect"} {
		t.Run(operation, func(t *testing.T) {
			state := controlState()
			state["turns"] = []any{map[string]any{"turnId": "target", "status": "completed",
				"items": json.RawMessage(`[` + strings.Repeat("1,", desktopControlNodeLimit) + `1]`)}}
			path := desktopFixture(t, func(c *desktopConn) error {
				if err := controlHandshake(c); err != nil {
					return err
				}
				var err error
				if operation == "inspect" {
					err = controlSnapshot(c, state, nil)
				} else {
					err = controlPreflight(c, state, nil)
				}
				if err != nil {
					return err
				}
				return controlExpectClosed(c)
			})
			ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
			defer cancel()
			controller := NewDesktopController(path)
			var err error
			switch operation {
			case "readiness":
				err = controller.CheckSendReadiness(ctx, "session")
			case "prepare":
				var prepared PreparedDesktopSend
				prepared, err = controller.PrepareSend(ctx, controlRequest())
				if prepared != nil {
					prepared.Close()
					t.Fatal("oversized structural state granted dispatch preparation")
				}
			case "inspect":
				_, err = controller.InspectTurn(ctx, "session", "target")
			}
			if !errors.Is(err, errDesktopControlStateLimit) || IsUncertain(err) || len(controller.slots) != 0 {
				t.Fatalf("dense snapshot did not fail before dispatch or release slot: %v slots=%d", err, len(controller.slots))
			}
		})
	}
}
