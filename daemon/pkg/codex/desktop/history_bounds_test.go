package desktop

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

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type historyCountingConn struct {
	net.Conn
	reader   *bytes.Reader
	requests []int
}

func (connection *historyCountingConn) Read(buffer []byte) (int, error) {
	connection.requests = append(connection.requests, len(buffer))
	return connection.reader.Read(buffer)
}

func TestDesktopHistoryFrameLimitsRejectBeforeBody(t *testing.T) {
	for _, limit := range []int{desktopInboundFrameLimit, desktopHistoryRawLimit} {
		var header [4]byte
		binary.LittleEndian.PutUint32(header[:], uint32(limit+1))
		connection := &historyCountingConn{reader: bytes.NewReader(header[:])}
		_, err := (&desktopConn{Conn: connection}).readWithLimit(limit)
		if !errors.Is(err, errDesktopFrameTooLarge) || len(connection.requests) != 1 || connection.requests[0] != 4 {
			t.Fatalf("limit=%d err=%v reads=%v", limit, err, connection.requests)
		}
	}
}

func TestDesktopHistoryLargeFrameUsesSharedInboundLimit(t *testing.T) {
	encoded, err := json.Marshal(map[string]any{"type": "broadcast", "method": "fixture", "params": strings.Repeat("x", desktopOutboundFrameLimit)})
	if err != nil {
		t.Fatal(err)
	}
	frame := make([]byte, 4+len(encoded))
	binary.LittleEndian.PutUint32(frame, uint32(len(encoded)))
	copy(frame[4:], encoded)
	ordinary := &historyCountingConn{reader: bytes.NewReader(frame)}
	if envelope, err := (&desktopConn{Conn: ordinary}).read(); err != nil || envelope.Method != "fixture" {
		t.Fatalf("shared inbound limit rejected bounded frame: %v", err)
	}
	history := &historyCountingConn{reader: bytes.NewReader(frame)}
	if envelope, err := (&desktopConn{Conn: history}).readWithLimit(desktopHistoryRawLimit); err != nil || envelope.Method != "fixture" {
		t.Fatalf("history limit rejected bounded frame: %v", err)
	}
	if _, err := decodeDesktopHistoryState(make([]byte, desktopHistoryRawLimit+1)); err == nil || err.Error() != protocol.HistoryTooLarge {
		t.Fatalf("raw cache bound=%v", err)
	}
}

func TestDesktopHistoryOversizedStreamMapsTooLarge(t *testing.T) {
	state := historyTestState(true)
	historyTestCanonical(state)["isComplete"] = false
	path := desktopFixture(t, func(c *desktopConn) error {
		if err := historyFixtureStart(c, state); err != nil {
			return err
		}
		if _, err := historyFixtureLoad(c); err != nil {
			return err
		}
		var header [4]byte
		binary.LittleEndian.PutUint32(header[:], uint32(desktopHistoryRawLimit+1))
		if _, err := io.Copy(c, bytes.NewReader(header[:])); err != nil {
			return err
		}
		return historyFixtureEnd(c)
	})
	reader := NewDesktopHistoryReader(path)
	t.Cleanup(reader.Reset)
	ctx, cancel := context.WithTimeout(context.Background(), desktopTestTimeout)
	defer cancel()
	if _, _, err := reader.ReadHistory(ctx, "session", "", "", 2); err == nil || err.Error() != protocol.HistoryTooLarge {
		t.Fatalf("oversize mapped incorrectly=%v", err)
	}
}

func TestDesktopHistoryStartKindDoesNotEstablishReadEligibility(t *testing.T) {
	for _, kind := range []string{"missing", "null", "default", "future"} {
		t.Run(kind, func(t *testing.T) {
			state := historyTestState(false)
			switch kind {
			case "missing":
				delete(state, "threadStartKind")
			case "null":
				state["threadStartKind"] = nil
			default:
				state["threadStartKind"] = kind
			}
			view, err := projectDesktopHistory(state, "session")
			if err != nil || !view.complete {
				t.Fatalf("read used send-only start kind: %v", err)
			}
		})
	}
}
