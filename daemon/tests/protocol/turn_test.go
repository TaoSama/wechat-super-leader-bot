package protocol_test

import (
	"strings"
	"testing"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

func TestExactTurnIDValidation(t *testing.T) {
	for _, id := range []string{"target", "turn-123_opaque:token", strings.Repeat("a", protocol.MaxTurnIDLength), strings.Repeat("界", 42), "turn\ufeffid"} {
		if !protocol.ValidTurnID(id) {
			t.Fatalf("valid opaque turn ID rejected: bytes=%d", len(id))
		}
	}
	for _, id := range []string{"", " ", " target", "target ", "one two", "one\ttwo", "one\ntwo", "one\rtwo", "one\u00a0two", "one\u2003two", "one\u0085two", "one\x00two", "one\x01two", "one\x7ftwo", "one\u009ftwo", "one\ufffdtwo", strings.Repeat("a", protocol.MaxTurnIDLength+1), strings.Repeat("界", 43), string([]byte{0xff})} {
		if protocol.ValidTurnID(id) {
			t.Fatalf("malformed turn ID accepted: bytes=%d", len(id))
		}
	}
}
