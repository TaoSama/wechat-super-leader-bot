package desktop

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"
)

// Deliberately independent of the implementation constant: these positions
// exercise the promised 32 KiB read boundary and both adjacent byte offsets.
var subscriptionBoundaryOffsets = []int{32767, 32768, 32769}

func subscriptionBoundaryRest() string {
	return strings.TrimPrefix(largeFrameEnvelope(`{"type":"snapshot","revision":1,"conversationState":{"id":"session","hostId":"local","threadRuntimeStatus":{"type":"idle"}}}`), "{")
}

func subscriptionBoundaryAssert(t *testing.T, body string, valid bool) {
	t.Helper()
	c, source := largeFrameConnection(strings.NewReader(body), len(body))
	budget := newDesktopFrameBudget(1, time.Second)
	projection := &desktopProjection{owner: "owner"}
	observation, err := largeFrameApply(t, c, budget, projection)
	if len(budget.slots) != 0 {
		t.Fatal("boundary scan retained its frame permit")
	}
	if !valid {
		if err == nil || observation.Availability != "" || projection.initialized {
			t.Fatalf("invalid boundary sequence published a state: err=%v observation=%+v", err, observation)
		}
		return
	}
	if err != nil || observation.Availability != "available" || observation.Status != "idle" || observation.Revision != 1 || source.readBytes != len(body)+4 {
		t.Fatalf("valid boundary sequence lost state or frame bytes: err=%v observation=%+v read=%d want=%d", err, observation, source.readBytes, len(body)+4)
	}
}

func TestDesktopSubscriptionJSONBufferStringBoundaries(t *testing.T) {
	cases := []struct {
		name, fragment string
		valid          bool
	}{
		{"UTF-8 rune", "雪", true},
		{"UTF-8 supplementary rune", "😀", true},
		{"replacement rune", "\uFFFD", true},
		{"escaped quote", `\"tail`, true},
		{"escaped backslash", `\\tail`, true},
		{"escaped solidus", `\/tail`, true},
		{"surrogate pair", `\uD83D\uDE00`, true},
		{"truncated UTF-8 rune", string([]byte{0xe9, 0x9b}), false},
		{"overlong UTF-8 rune", string([]byte{0xc0, 0xaf}), false},
		{"invalid UTF-8 continuation", string([]byte{0xe9, 'x', 0xaa}), false},
		{"unpaired high surrogate", `\uD83D`, false},
		{"unpaired low surrogate", `\uDE00`, false},
		{"surrogate followed by ordinary rune", `\uD83D\u0041`, false},
		{"invalid escape", `\q`, false},
		{"truncated escape", `\`, false},
		{"raw control byte", "\x01", false},
	}
	for _, offset := range subscriptionBoundaryOffsets {
		for _, tc := range cases {
			t.Run(fmt.Sprintf("%d/%s", offset, tc.name), func(t *testing.T) {
				prefix := `{"ignored":"`
				body := prefix + strings.Repeat("x", offset-len(prefix)) + tc.fragment + `",` + subscriptionBoundaryRest()
				subscriptionBoundaryAssert(t, body, tc.valid)
			})
		}
		t.Run(fmt.Sprintf("%d/closing quote", offset), func(t *testing.T) {
			prefix := `{"ignored":"`
			body := prefix + strings.Repeat("x", offset-len(prefix)) + `",` + subscriptionBoundaryRest()
			subscriptionBoundaryAssert(t, body, true)
		})
		for _, tc := range []struct {
			name, fragment string
			valid          bool
		}{
			{"surrogate halves split", `\uD83D\uDE00`, true},
			{"invalid surrogate halves split", `\uD83D\u0041`, false},
		} {
			t.Run(fmt.Sprintf("%d/%s", offset, tc.name), func(t *testing.T) {
				prefix := `{"ignored":"`
				// Position the low surrogate's backslash at the boundary, so
				// validating the pair crosses a fill between its two halves.
				body := prefix + strings.Repeat("x", offset-len(prefix)-6) + tc.fragment + `",` + subscriptionBoundaryRest()
				subscriptionBoundaryAssert(t, body, tc.valid)
			})
		}
	}
}

func TestDesktopSubscriptionJSONBufferNumberBoundaries(t *testing.T) {
	cases := []struct {
		name, padding, fragment string
		valid                   bool
	}{
		{"long integer delimiter", "1", "", true},
		{"long fraction", "1", ".25", true},
		{"long exponent", "1", "e+12", true},
		{"fraction and exponent", "1", ".25E-12", true},
		{"missing fraction digits", "1", ".", false},
		{"missing exponent digits", "1", "e+", false},
		{"invalid exponent sign", "1", "e++1", false},
		{"non-digit suffix", "1", "a", false},
		{"zero", " ", "0", true},
		{"leading zero", " ", "01", false},
		{"negative fraction", " ", "-0.25e-2", true},
		{"missing integer", " ", "-.5", false},
		{"minus only", " ", "-", false},
	}
	for _, offset := range subscriptionBoundaryOffsets {
		for _, tc := range cases {
			t.Run(fmt.Sprintf("%d/%s", offset, tc.name), func(t *testing.T) {
				prefix := `{"ignored":`
				body := prefix + strings.Repeat(tc.padding, offset-len(prefix)) + tc.fragment + `,` + subscriptionBoundaryRest()
				subscriptionBoundaryAssert(t, body, tc.valid)
			})
		}
	}
}

func TestDesktopSubscriptionJSONBufferWhitespaceBoundaries(t *testing.T) {
	for _, offset := range subscriptionBoundaryOffsets {
		for _, tc := range []struct {
			name, fragment string
			valid          bool
		}{
			{"JSON whitespace", "\r\n\t ", true},
			{"vertical tab", "\v", false},
			{"NUL", "\x00", false},
			{"nonbreaking space", "\u00a0", false},
		} {
			t.Run(fmt.Sprintf("%d/%s", offset, tc.name), func(t *testing.T) {
				prefix := `{"ignored":true`
				body := prefix + strings.Repeat(" ", offset-len(prefix)) + tc.fragment + `,` + subscriptionBoundaryRest()
				subscriptionBoundaryAssert(t, body, tc.valid)
			})
		}
	}
}

func TestDesktopSubscriptionJSONBufferTailDoesNotConsumeNextFrame(t *testing.T) {
	prefix := `{"ignored":"`
	first := prefix + strings.Repeat("x", 32767-len(prefix)) + `雪\uD83D\uDE00",` + subscriptionBoundaryRest()
	second := largeFrameEnvelope(`{"type":"patches","baseRevision":1,"revision":2,"patches":[{"value":"active","path":["threadRuntimeStatus","type"],"op":"replace"}]}`)
	framed := func(body string) string {
		var header [4]byte
		binary.LittleEndian.PutUint32(header[:], uint32(len(body)))
		return string(header[:]) + body
	}
	source := &largeFrameReaderConn{reader: strings.NewReader(framed(first) + framed(second))}
	c := &desktopConn{Conn: source, clientID: largeFrameTestClient}
	projection := &desktopProjection{owner: "owner"}
	budget := newDesktopFrameBudget(1, time.Second)
	firstObservation, err := largeFrameApply(t, c, budget, projection)
	if err != nil || firstObservation.Status != "idle" || source.readBytes != len(first)+4 {
		t.Fatalf("boundary scalar consumed trailing frame: err=%v observation=%+v read=%d", err, firstObservation, source.readBytes)
	}
	secondObservation, err := largeFrameApply(t, c, budget, projection)
	if err != nil || secondObservation.Status != "active" || secondObservation.Revision != 2 || source.readBytes != len(first)+len(second)+8 {
		t.Fatalf("second frame was not independently readable: err=%v observation=%+v read=%d", err, secondObservation, source.readBytes)
	}
}

type subscriptionBoundaryCancelReader struct {
	reader               io.Reader
	cancel               context.CancelFunc
	canceled             bool
	readBytes            int
	readAfterCancel      int
	maximumReadBufferLen int
}

func (r *subscriptionBoundaryCancelReader) Read(p []byte) (int, error) {
	r.maximumReadBufferLen = max(r.maximumReadBufferLen, len(p))
	wasCanceled := r.canceled
	n, err := r.reader.Read(p)
	r.readBytes += n
	if wasCanceled {
		r.readAfterCancel += n
	} else if r.readBytes >= 32768 {
		r.canceled = true
		r.cancel()
	}
	return n, err
}

func TestDesktopSubscriptionJSONBufferCancellationReadBound(t *testing.T) {
	for _, tc := range []struct{ name, prefix, pattern, suffix string }{
		{"ASCII string", `{"ignored":"`, "x", `"}`},
		{"whitespace", `{`, " ", `"ignored":true}`},
		{"digits", `{"ignored":`, "1", `}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body, size := largeFrameSnapshotBody(tc.prefix, tc.pattern, tc.suffix, 1024*1024)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			source := &subscriptionBoundaryCancelReader{reader: body, cancel: cancel}
			c, _ := largeFrameConnection(source, size)
			budget := newDesktopFrameBudget(1, time.Second)
			consumed := false
			err := c.readBudgeted(ctx, budget, func(desktopEnvelope) error { consumed = true; return nil })
			if !errors.Is(err, context.Canceled) || consumed || len(budget.slots) != 0 || !source.canceled || source.maximumReadBufferLen > 32768 || source.readAfterCancel > 32768 {
				t.Fatalf("canceled buffered scan exceeded bounded reads: err=%v consumed=%v slots=%d maxRead=%d afterCancel=%d", err, consumed, len(budget.slots), source.maximumReadBufferLen, source.readAfterCancel)
			}
		})
	}
}

func TestDesktopSubscriptionJSONTruncatedBodyIsUnexpectedEOF(t *testing.T) {
	for _, body := range []string{"", `{"ignored":`, `{"ignored":1e`, `{"ignored":true`} {
		t.Run(fmt.Sprintf("length=%d", len(body)), func(t *testing.T) {
			c, _ := largeFrameConnection(strings.NewReader(body), max(1, len(body)))
			budget := newDesktopFrameBudget(1, time.Second)
			consumed := false
			err := c.readBudgeted(t.Context(), budget, func(desktopEnvelope) error { consumed = true; return nil })
			if !errors.Is(err, io.ErrUnexpectedEOF) || consumed || len(budget.slots) != 0 {
				t.Fatalf("accepted header followed by truncated body looked like clean EOF: err=%v consumed=%v slots=%d", err, consumed, len(budget.slots))
			}
		})
	}
}
