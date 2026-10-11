package protocol_test

import (
	"strings"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestHistoryRequestBounds(t *testing.T) {
	base := protocol.ReadHistoryMessage{Type: "read_history", NodeID: "node", RequestID: "request", SessionID: "session"}
	for _, limit := range []int{0, 1, 30, 50} {
		msg := base
		msg.Limit = limit
		if err := msg.Validate("node"); err != nil {
			t.Fatalf("valid limit %d rejected", limit)
		}
	}
	for _, mutate := range []func(*protocol.ReadHistoryMessage){
		func(m *protocol.ReadHistoryMessage) { m.NodeID = "other" },
		func(m *protocol.ReadHistoryMessage) { m.SessionID = "" },
		func(m *protocol.ReadHistoryMessage) { m.RequestID = " bad " },
		func(m *protocol.ReadHistoryMessage) { m.Limit = -1 },
		func(m *protocol.ReadHistoryMessage) { m.Limit = 51 },
		func(m *protocol.ReadHistoryMessage) {
			m.Cursor = strings.Repeat("c", protocol.MaxHistoryCursorLength+1)
		},
	} {
		msg := base
		mutate(&msg)
		if err := msg.Validate("node"); err == nil || err.Error() != protocol.HistoryInvalidRequest {
			t.Fatalf("invalid request not rejected statically: %+v", msg)
		}
	}
}
