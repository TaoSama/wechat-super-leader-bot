package codex

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type desktopFramePolicyConn struct {
	net.Conn
	reader       *bytes.Reader
	readSizes    []int
	writeCalls   int
	writtenBytes int
}

func (c *desktopFramePolicyConn) Read(buffer []byte) (int, error) {
	c.readSizes = append(c.readSizes, len(buffer))
	return c.reader.Read(buffer)
}

func (c *desktopFramePolicyConn) Write(buffer []byte) (int, error) {
	c.writeCalls++
	c.writtenBytes += len(buffer)
	return len(buffer), nil
}

func (c *desktopFramePolicyConn) SetReadDeadline(time.Time) error { return nil }

func TestDesktopFrameInboundPolicy(t *testing.T) {
	t.Run("exact limit", func(t *testing.T) {
		body := bytes.Repeat([]byte(" "), desktopInboundFrameLimit)
		copy(body, []byte(`{"type":"broadcast","version":11,"method":"thread-stream-state-changed"}`))
		frame := make([]byte, 4+len(body))
		binary.LittleEndian.PutUint32(frame, uint32(len(body)))
		copy(frame[4:], body)
		connection := &desktopFramePolicyConn{reader: bytes.NewReader(frame)}
		message, err := (&desktopConn{Conn: connection}).read()
		if err != nil || message.Method != desktopStateChanged || message.Version != 11 {
			t.Fatalf("exact inbound limit rejected: %v", err)
		}
	})
	t.Run("header only rejection", func(t *testing.T) {
		var header [4]byte
		binary.LittleEndian.PutUint32(header[:], uint32(desktopInboundFrameLimit+1))
		connection := &desktopFramePolicyConn{reader: bytes.NewReader(header[:])}
		_, err := (&desktopConn{Conn: connection}).read()
		if !errors.Is(err, errDesktopFrameTooLarge) || len(connection.readSizes) != 1 || connection.readSizes[0] != len(header) {
			t.Fatalf("oversized inbound body read: err=%v reads=%v", err, connection.readSizes)
		}
	})
}

func TestDesktopBudgetedFrameInboundPolicy(t *testing.T) {
	t.Run("oversized does not wait for occupied budget", func(t *testing.T) {
		budget := newDesktopFrameBudget(1, time.Second)
		if err := budget.acquire(context.Background()); err != nil {
			t.Fatal(err)
		}
		defer budget.release()
		var header [4]byte
		binary.LittleEndian.PutUint32(header[:], uint32(desktopInboundFrameLimit+1))
		connection := &desktopFramePolicyConn{reader: bytes.NewReader(header[:])}
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		err := (&desktopConn{Conn: connection}).readBudgeted(ctx, budget, func(desktopEnvelope) error {
			t.Error("oversized frame reached projection")
			return nil
		})
		if !errors.Is(err, errDesktopFrameTooLarge) || len(connection.readSizes) != 1 || connection.readSizes[0] != len(header) || len(budget.slots) != 1 {
			t.Fatalf("oversized frame consumed body/budget: err=%v reads=%v slots=%d", err, connection.readSizes, len(budget.slots))
		}
	})
	t.Run("exact limit remains accepted", func(t *testing.T) {
		body := bytes.Repeat([]byte(" "), desktopInboundFrameLimit)
		copy(body, []byte(`{"type":"broadcast","version":11,"method":"thread-stream-state-changed"}`))
		var header [4]byte
		binary.LittleEndian.PutUint32(header[:], uint32(len(body)))
		connection := &desktopFramePolicyConn{reader: bytes.NewReader(append(header[:], body...))}
		budget := newDesktopFrameBudget(1, time.Second)
		projected := false
		err := (&desktopConn{Conn: connection}).readBudgeted(context.Background(), budget, func(message desktopEnvelope) error {
			projected = message.Method == desktopStateChanged && message.Version == 11 && len(budget.slots) == 1
			return nil
		})
		if err != nil || !projected || len(budget.slots) != 0 {
			t.Fatalf("exact inbound frame rejected/slot retained: err=%v projected=%v slots=%d", err, projected, len(budget.slots))
		}
	})
}

func TestDesktopFrameOutboundPolicy(t *testing.T) {
	for _, size := range []int{desktopOutboundFrameLimit, desktopOutboundFrameLimit + 1} {
		envelope := desktopEnvelope{Type: "request", Method: "fixture", Params: json.RawMessage(`""`)}
		base, err := json.Marshal(envelope)
		if err != nil {
			t.Fatal(err)
		}
		envelope.Params = json.RawMessage(`"` + strings.Repeat("x", size-len(base)) + `"`)
		connection := &desktopFramePolicyConn{}
		err = (&desktopConn{Conn: connection}).write(envelope)
		if size > desktopOutboundFrameLimit {
			if err == nil || err.Error() != "desktop request too large" || connection.writeCalls != 0 {
				t.Fatalf("oversized outbound frame written: err=%v writes=%d", err, connection.writeCalls)
			}
		} else if err != nil || connection.writeCalls == 0 || connection.writtenBytes != size+4 {
			t.Fatalf("exact outbound limit rejected: err=%v written=%d", err, connection.writtenBytes)
		}
	}
}

func desktopFramePolicySnapshot(recipient string, state map[string]any) ([]byte, error) {
	params, err := json.Marshal(map[string]any{"conversationId": "session", "hostId": "local", "change": map[string]any{
		"type": "snapshot", "revision": 1, "conversationState": state,
	}})
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(desktopEnvelope{Type: "broadcast", Method: desktopStateChanged, Version: 11,
		SourceClientID: "owner", TargetClientIDs: []string{recipient}, Params: params})
	if err != nil {
		return nil, err
	}
	if len(body) <= desktopOutboundFrameLimit || len(body) > desktopInboundFrameLimit {
		return nil, errors.New("fixture snapshot is outside asymmetric frame limits")
	}
	return body, nil
}

// Native-to-daemon fixtures bypass write(), whose outbound request policy must
// remain narrower than the inbound native snapshot policy. Keep the fixture's
// transfer deadline, but let the client's own operation budget govern decoding:
// race instrumentation must not turn CPU-only projection into a server timeout.
// Fixture cleanup still closes and joins the connection after the client ends.
func desktopFixtureWriteSnapshot(c *desktopConn, body []byte) error {
	var header [4]byte
	binary.LittleEndian.PutUint32(header[:], uint32(len(body)))
	if _, err := io.Copy(c, io.MultiReader(bytes.NewReader(header[:]), bytes.NewReader(body))); err != nil {
		return err
	}
	return c.SetReadDeadline(time.Time{})
}

func desktopFramePolicyState() map[string]any {
	state := controlState()
	state["turns"] = []any{map[string]any{"turnId": "turn", "status": "completed", "items": []any{
		map[string]any{"id": "item", "type": "agentMessage", "text": strings.Repeat("x", desktopOutboundFrameLimit)},
	}}}
	return state
}

func TestDesktopFrameLargeObserverSnapshot(t *testing.T) {
	body, err := desktopFramePolicySnapshot("observer-client", desktopFramePolicyState())
	if err != nil {
		t.Fatal(err)
	}
	path := desktopFixture(t, func(c *desktopConn) error {
		if err := desktopOwnerSubscribe(c); err != nil {
			return err
		}
		if err := desktopFixtureWriteSnapshot(c, body); err != nil {
			return err
		}
		if err := desktopExpectFollow(c, false); err != nil {
			return err
		}
		return desktopExpectClosed(c)
	})
	var observations []protocol.DesktopObservation
	err = NewDesktopObserver(path).Snapshot(t.Context(), []string{"session"}, func(id string, observation protocol.DesktopObservation) {
		if id != "session" {
			t.Errorf("snapshot attached to wrong session: %q", id)
		}
		observations = append(observations, observation)
	})
	if err != nil || len(observations) != 1 || observations[0].OwnerID != "owner" || observations[0].Availability != "available" || observations[0].Status != "idle" || observations[0].Revision != 1 {
		t.Fatalf("large observer snapshot unavailable: err=%v observations=%+v", err, observations)
	}
	public, err := json.Marshal(observations[0])
	if err != nil || len(public) > 1024 {
		t.Fatalf("large history escaped observer projection: bytes=%d err=%v", len(public), err)
	}
}

func TestDesktopFrameLargeSendReadinessSnapshot(t *testing.T) {
	body, err := desktopFramePolicySnapshot("control-client", desktopFramePolicyState())
	if err != nil {
		t.Fatal(err)
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
			return errors.New("unexpected send readiness settings request")
		}
		if err := desktopReply(c, request, "owner", map[string]any{"settings": map[string]any{
			"mode": "default", "threadSource": "user", "resumeState": "resumed",
		}}); err != nil {
			return err
		}
		follow, err := c.read()
		if err != nil {
			return err
		}
		if follow.Type != "broadcast" || follow.Method != desktopFollowingChanged {
			return errors.New("unexpected send readiness snapshot subscription")
		}
		if err := desktopFixtureWriteSnapshot(c, body); err != nil {
			return err
		}
		return controlExpectClosed(c)
	})
	if err := NewDesktopController(path).CheckSendReadiness(t.Context(), "session"); err != nil {
		t.Fatalf("large send readiness snapshot unavailable: %v", err)
	}
}
