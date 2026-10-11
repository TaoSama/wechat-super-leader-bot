package transcript

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

type cancelOnCheck struct {
	context.Context
	cancel context.CancelFunc
	checks atomic.Int32
}

func (c *cancelOnCheck) Err() error {
	if c.checks.Add(1) == 100 {
		c.cancel()
	}
	return c.Context.Err()
}

func TestCancellationWhileValidatingRecord(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	checked := &cancelOnCheck{Context: ctx, cancel: cancel}
	r, ref, _ := fixture(t, "codex", meta()+`{"type":"future","values":[`+strings.Repeat("0,", 10000)+"0]}\n")
	page, _, err := r.Read(checked, ref, "", "", 1)
	if err == nil || err.Error() != context.Canceled.Error() || len(page.Items) != 0 {
		t.Fatalf("mid-record cancellation: %+v %v", page, err)
	}
}

func TestGrokVisibleChunkRequiresExactIdentity(t *testing.T) {
	for _, role := range []string{"user_message_chunk", "agent_message_chunk"} {
		for name, session := range map[string]string{"missing": "", "empty": `"sessionId":"",`, "null": `"sessionId":null,`, "number": `"sessionId":123,`, "wrong": `"sessionId":"other",`} {
			t.Run(role+"-"+name, func(t *testing.T) {
				data := `{"method":"session/update","params":{` + session + `"update":{"sessionUpdate":"` + role + `","content":{"type":"text","text":"SECRET_unbound"}}}}` + "\n"
				r, ref, _ := fixture(t, "grok", data)
				page, _, err := r.Read(context.Background(), ref, "", "", 1)
				if err == nil || len(page.Items) != 0 {
					t.Fatalf("unbound chunk published: %+v %v", page, err)
				}
			})
		}
	}
}

func TestTextClippingUsesBothUnicodeBudgets(t *testing.T) {
	for name, text := range map[string]string{"ascii": strings.Repeat("a", 20000), "emoji": strings.Repeat("😀", 10000), "mixed": strings.Repeat("中😀a", 5000)} {
		t.Run(name, func(t *testing.T) {
			clipped, truncated := clipText(text)
			if !truncated || len(clipped) > MaxTextBytes || len(utf16.Encode([]rune(clipped))) > protocol.MaxHistoryTextLength || !utf8.ValidString(clipped) || !strings.HasPrefix(text, clipped) {
				t.Fatalf("bad Unicode clipping: %d bytes", len(clipped))
			}
		})
	}
}

func TestInvalidOptionalFieldsAndUnknownFormat(t *testing.T) {
	for _, data := range []string{
		`{"type":"session_meta","payload":{"id":"` + testID + `","source":null}}` + "\n",
		meta() + `{"type":"response_item","payload":{"type":"message","role":"assistant","phase":null,"content":[{"type":"output_text","text":"SECRET"}]}}` + "\n",
		meta() + `{"type":"response_item","payload":{"type":"message","role":"assistant","content":null}}` + "\n",
		meta() + `{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":null}]}}` + "\n",
	} {
		r, ref, _ := fixture(t, "codex", data)
		_, _, err := r.Read(context.Background(), ref, "", "", 1)
		assertError(t, err, protocol.HistoryIncomplete)
	}
	for _, data := range []string{
		`{"type":"assistant","sessionId":"` + testID + `","isSidechain":null,"message":{"role":"assistant","content":"SECRET"}}` + "\n",
		`{"type":"assistant","sessionId":"` + testID + `","message":{"role":"assistant","content":null}}` + "\n",
	} {
		r, ref, _ := fixture(t, "claude", data)
		_, _, err := r.Read(context.Background(), ref, "", "", 1)
		assertError(t, err, protocol.HistoryIncomplete)
	}
	r, ref, _ := fixture(t, "grok", `{"method":"session/update","params":{"update":{"sessionUpdate":"future_event","content":{"type":"text","text":"SECRET"}}}}`+"\n")
	_, _, err := r.Read(context.Background(), ref, "", "", 1)
	assertError(t, err, protocol.HistoryUnavailable)
}
