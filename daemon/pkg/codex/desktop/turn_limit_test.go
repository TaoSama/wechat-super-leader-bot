package desktop

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const desktopTurnFixtureFrameLimit = 64 * 1024 * 1024

func desktopTurnLimitFollow(c *desktopConn) error {
	message, err := c.read()
	if err != nil {
		return err
	}
	var params map[string]any
	if err := json.Unmarshal(message.Params, &params); err != nil {
		return err
	}
	want := map[string]any{"conversationId": "session", "hostId": "local", "following": true}
	if message.Type != "broadcast" || message.Method != desktopFollowingChanged || message.Version != 1 ||
		message.SourceClientID != "control-client" || !reflect.DeepEqual(message.TargetClientIDs, []string{"owner"}) || !reflect.DeepEqual(params, want) {
		return fmt.Errorf("unexpected read-only snapshot subscription: method=%q params=%s", message.Method, message.Params)
	}
	return nil
}

func desktopTurnLimitBody(t *testing.T, output string) []byte {
	t.Helper()
	state := controlState()
	state["turns"] = []any{
		map[string]any{"turnId": "target", "status": "completed", "items": []any{
			map[string]any{"type": "agentMessage", "phase": "commentary", "text": "intermediate output"},
			map[string]any{"type": "agentMessage", "phase": "final_answer", "text": output},
		}},
		map[string]any{"turnId": "newer-unrelated-turn", "status": "completed", "items": []any{
			map[string]any{"type": "agentMessage", "phase": "final_answer", "text": "unrelated final output"},
		}},
	}
	params, err := json.Marshal(map[string]any{"conversationId": "session", "hostId": "local", "change": map[string]any{
		"type": "snapshot", "revision": 1, "conversationState": state,
	}})
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(desktopEnvelope{Type: "broadcast", Method: desktopStateChanged, Version: 11,
		SourceClientID: "owner", TargetClientIDs: []string{"control-client"}, Params: params})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func TestDesktopInspectTurnPreservesMarkdownAboveOrdinaryFrameLimit(t *testing.T) {
	const prefix = "# 完整结果\n\n```html\n"
	const suffix = "\n```\n\n| 项目 | 值 |\n| --- | --- |\n| 验证 | ✅ |\n"
	output := prefix + strings.Repeat("<", protocol.MaxTurnOutputBytes-len(prefix)-len(suffix)) + suffix
	if len(output) != protocol.MaxTurnOutputBytes || !utf8.ValidString(output) {
		t.Fatal("fixture must exercise the exact original UTF-8 output boundary")
	}
	body := desktopTurnLimitBody(t, output)
	if len(body) <= desktopInboundFrameLimit || len(body) > desktopTurnFixtureFrameLimit {
		t.Fatalf("escaped native fixture must exceed the ordinary frame limit: raw=%d wire=%d", len(output), len(body))
	}
	t.Logf("original UTF-8 bytes=%d native JSON frame bytes=%d", len(output), len(body))
	path := desktopFixture(t, func(c *desktopConn) error {
		if err := controlHandshake(c); err != nil {
			return err
		}
		if err := desktopTurnLimitFollow(c); err != nil {
			return err
		}
		if err := desktopFixtureWriteSnapshot(c, body); err != nil {
			return err
		}
		return controlExpectClosed(c)
	})
	controller := NewDesktopController(path)
	observation, err := controller.InspectTurn(context.Background(), "session", "target")
	if err != nil || observation.Status != "completed" || observation.Output != output || observation.Error != "" {
		t.Fatalf("original Markdown changed or was rejected: status=%q raw=%d got=%d error=%v", observation.Status, len(output), len(observation.Output), err)
	}
	if len(controller.slots) != 0 {
		t.Fatal("completed observation retained its controller slot")
	}
}

func TestDesktopInspectTurnOversizedFrameIsExplicitAndReadOnly(t *testing.T) {
	path := desktopFixture(t, func(c *desktopConn) error {
		if err := controlHandshake(c); err != nil {
			return err
		}
		if err := desktopTurnLimitFollow(c); err != nil {
			return err
		}
		var header [4]byte
		binary.LittleEndian.PutUint32(header[:], desktopTurnFixtureFrameLimit+1)
		if _, err := io.Copy(c, bytes.NewReader(header[:])); err != nil {
			return err
		}
		// With no body supplied, only a header-level rejection can finish.
		// Any start/resume/fallback request fails this read-only fixture.
		return controlExpectClosed(c)
	})
	controller := NewDesktopController(path)
	observation, err := controller.InspectTurn(context.Background(), "session", "target")
	if !errors.Is(err, protocol.ErrTurnObservationLimit) || observation.Status != "" || observation.Output != "" {
		t.Fatalf("oversized native frame must fail explicitly without partial output: status=%q output=%d error=%v", observation.Status, len(observation.Output), err)
	}
	if len(controller.slots) != 0 {
		t.Fatal("rejected observation retained its controller slot")
	}
}

func TestDesktopOrdinaryFrameLimitRemainsScoped(t *testing.T) {
	const ordinaryLimit = 32 * 1024 * 1024
	if desktopInboundFrameLimit != ordinaryLimit {
		t.Fatalf("ordinary desktop frame limit changed: %d", desktopInboundFrameLimit)
	}
	var header [4]byte
	binary.LittleEndian.PutUint32(header[:], ordinaryLimit+1)
	connection := &historyCountingConn{reader: bytes.NewReader(header[:])}
	if _, err := (&desktopConn{Conn: connection}).read(); !errors.Is(err, errDesktopFrameTooLarge) || !reflect.DeepEqual(connection.requests, []int{len(header)}) {
		t.Fatalf("ordinary read consumed an oversized body: error=%v reads=%v", err, connection.requests)
	}
	path := desktopFixture(t, func(c *desktopConn) error {
		if err := controlHandshake(c); err != nil {
			return err
		}
		request, err := c.read()
		if err != nil {
			return err
		}
		if request.Method != desktopReadSettings || request.TargetClientID != "owner" {
			return errors.New("unexpected send-readiness settings request")
		}
		if err := desktopReply(c, request, "owner", map[string]any{"settings": map[string]any{
			"mode": "default", "threadSource": "user", "resumeState": "resumed",
		}}); err != nil {
			return err
		}
		if err := desktopTurnLimitFollow(c); err != nil {
			return err
		}
		if _, err := io.Copy(c, bytes.NewReader(header[:])); err != nil {
			return err
		}
		return controlExpectClosed(c)
	})
	if err := NewDesktopController(path).CheckSendReadiness(context.Background(), "session"); !errors.Is(err, errDesktopFrameTooLarge) {
		t.Fatalf("ordinary control snapshot adopted the turn-only limit: %v", err)
	}
}
