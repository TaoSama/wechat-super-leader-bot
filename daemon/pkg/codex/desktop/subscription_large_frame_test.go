package desktop

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const largeFrameTestClient = "large-client"

// Generate the discarded body incrementally so allocation measurements describe
// the reader/projection, rather than a test's preallocated input buffer.
type largeFrameRepeatReader struct {
	pattern string
	left    int64
	offset  int
}

func (r *largeFrameRepeatReader) Read(p []byte) (int, error) {
	if r.left == 0 {
		return 0, io.EOF
	}
	n := min(len(p), int(r.left))
	if len(r.pattern) == 1 && n > 0 {
		p[0] = r.pattern[0]
		for written := 1; written < n; {
			written += copy(p[written:n], p[:written])
		}
		r.left -= int64(n)
		return n, nil
	}
	for written := 0; written < n; {
		copied := copy(p[written:n], r.pattern[r.offset:])
		written += copied
		r.offset = (r.offset + copied) % len(r.pattern)
	}
	r.left -= int64(n)
	return n, nil
}

type largeFrameReaderConn struct {
	net.Conn
	reader    io.Reader
	readBytes int
}

func (c *largeFrameReaderConn) Read(p []byte) (int, error) {
	n, err := c.reader.Read(p)
	c.readBytes += n
	return n, err
}
func (c *largeFrameReaderConn) SetReadDeadline(time.Time) error { return nil }

func largeFrameConnection(body io.Reader, size int) (*desktopConn, *largeFrameReaderConn) {
	var header [4]byte
	binary.LittleEndian.PutUint32(header[:], uint32(size))
	c := &largeFrameReaderConn{reader: io.MultiReader(strings.NewReader(string(header[:])), body)}
	return &desktopConn{Conn: c, clientID: largeFrameTestClient}, c
}

func largeFrameEnvelope(change string) string {
	return `{"type":"broadcast","method":"thread-stream-state-changed","version":11,"sourceClientId":"owner","targetClientIds":["large-client"],"params":{"conversationId":"session","hostId":"local","change":` + change + `}}`
}

func largeFrameSnapshotBody(prefix, repeated, suffix string, repeats int) (io.Reader, int) {
	n := len(repeated) * repeats
	return io.MultiReader(strings.NewReader(prefix), &largeFrameRepeatReader{pattern: repeated, left: int64(n)}, strings.NewReader(suffix)), len(prefix) + n + len(suffix)
}

func largeFrameApply(t *testing.T, c *desktopConn, budget *desktopFrameBudget, projection *desktopProjection) (protocol.DesktopObservation, error) {
	t.Helper()
	var observation protocol.DesktopObservation
	err := c.readBudgeted(t.Context(), budget, func(message desktopEnvelope) error {
		return applyDesktopChange(message, largeFrameTestClient, map[string]*desktopProjection{"session": projection}, func(_ string, value protocol.DesktopObservation) {
			observation = value
		})
	})
	return observation, err
}

func TestDesktopSubscriptionLargeFrameProjectsWithoutBodyAllocation(t *testing.T) {
	const textBytes = desktopInboundFrameLimit + 1024
	prefix := largeFrameEnvelope(`{"type":"snapshot","revision":9,"conversationState":{"id":"session","hostId":"local","threadRuntimeStatus":{"type":"idle"},"latestModel":"fixture-model","modelProvider":"fixture-provider","latestReasoningEffort":"high","latestCollaborationMode":null,"turns":[{"turnId":"active","status":"inProgress","items":[{"text":"`)
	// Split inside the synthetic text while preserving the envelope's closing
	// braces. This body exceeds the old 32 MiB limit with one ignored scalar.
	prefix = strings.TrimSuffix(prefix, `}}`)
	suffix := `"}]}]}}}}`
	body, size := largeFrameSnapshotBody(prefix, "x", suffix, textBytes)
	c, source := largeFrameConnection(body, size)
	budget := newDesktopFrameBudget(1, 5*time.Second)
	projection := &desktopProjection{owner: "owner"}
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	observation, err := largeFrameApply(t, c, budget, projection)
	runtime.ReadMemStats(&after)
	if err != nil {
		t.Fatalf("valid snapshot above old 32 MiB limit rejected: %v", err)
	}
	if observation.Status != "idle" || observation.Availability != "available" || observation.OwnerID != "owner" || observation.Revision != 9 ||
		observation.Model != "fixture-model" || observation.ModelProvider != "fixture-provider" || observation.ReasoningEffort != "high" || observation.ActiveTurnID != "active" {
		t.Fatalf("large snapshot lost exact metadata: %+v", observation)
	}
	if source.readBytes != size+4 || len(budget.slots) != 0 || len(projection.turnMetadata) > 1024 {
		t.Fatalf("incomplete read, leaked permit or retained body: read=%d want=%d slots=%d retained=%d", source.readBytes, size+4, len(budget.slots), len(projection.turnMetadata))
	}
	const allocationLimit = 8 * 1024 * 1024
	if allocated := after.TotalAlloc - before.TotalAlloc; allocated > allocationLimit {
		t.Fatalf("ignored scalar was materialized: allocated=%d input=%d limit=%d", allocated, textBytes, allocationLimit)
	} else {
		t.Logf("discarded scalar bytes=%d, total reader/projection allocation=%d", textBytes, allocated)
	}
}

func TestDesktopSubscriptionLargeFrameManyDiscardedItems(t *testing.T) {
	prefix := `{"type":"broadcast","method":"thread-stream-state-changed","version":11,"sourceClientId":"owner","targetClientIds":["large-client"],"params":{"conversationId":"session","hostId":"local","change":{"type":"snapshot","revision":4,"conversationState":{"id":"session","hostId":"local","threadRuntimeStatus":{"type":"active"},"turns":[{"turnId":"recorded","status":"inProgress","items":[`
	item := `{"text":"` + strings.Repeat("x", 300) + `"},`
	count := desktopInboundFrameLimit/len(item) + 1
	body, size := largeFrameSnapshotBody(prefix, item, `{}]}]}}}}`, count)
	c, _ := largeFrameConnection(body, size)
	projection := &desktopProjection{owner: "owner"}
	observation, err := largeFrameApply(t, c, newDesktopFrameBudget(1, 5*time.Second), projection)
	if err != nil || observation.Status != "active" || observation.Revision != 4 || observation.ActiveTurnID != "recorded" || len(projection.turnMetadata) > 1024 {
		t.Fatalf("many discarded items changed exact state: err=%v observation=%+v retained=%d", err, observation, len(projection.turnMetadata))
	}
}

func TestDesktopSubscriptionLargeFrameMalformedInputNeverPublishes(t *testing.T) {
	state := `{"type":"snapshot","revision":2,"conversationState":{"id":"session","hostId":"local","threadRuntimeStatus":{"type":"idle"}}}`
	valid := largeFrameEnvelope(state)
	cases := []struct{ name, body string }{
		{"trailing value", valid + ` null`},
		{"truncated tail", valid[:len(valid)-1]},
		{"duplicate ignored key", strings.TrimSuffix(valid, `}`) + `,"ignored":{"x":1,"x":2}}`},
		{"escaped duplicate key", strings.TrimSuffix(valid, `}`) + `,"ignored":{"x":1,"\u0078":2}}`},
		{"invalid UTF-8 in ignored string", strings.TrimSuffix(valid, `}`) + ",\"ignored\":\"" + string([]byte{0xff}) + "\"}"},
		{"unpaired high surrogate", strings.TrimSuffix(valid, `}`) + `,"ignored":"\ud800"}`},
		{"unpaired low surrogate", strings.TrimSuffix(valid, `}`) + `,"ignored":"\udc00"}`},
		{"invalid number in ignored field", strings.TrimSuffix(valid, `}`) + `,"ignored":01}`},
		{"deep ignored subtree", strings.TrimSuffix(valid, `}`) + `,"ignored":` + strings.Repeat(`[`, 129) + `0` + strings.Repeat(`]`, 129) + `}`},
		{"oversized ignored key", strings.TrimSuffix(valid, `}`) + `,"` + strings.Repeat("k", 4097) + `":0}`},
		{"state identity alias", largeFrameEnvelope(`{"type":"snapshot","revision":2,"conversationState":{"id":"session","ID":"other","hostId":"local"}}`)},
		{"turn status alias", largeFrameEnvelope(`{"type":"snapshot","revision":2,"conversationState":{"id":"session","hostId":"local","turns":[{"turnId":"active","status":"completed","STATUS":"inProgress"}]}}`)},
		{"revision alias", largeFrameEnvelope(`{"type":"snapshot","revision":2,"Revision":3,"conversationState":{"id":"session","hostId":"local"}}`)},
		{"patch value alias", largeFrameEnvelope(`{"type":"patches","baseRevision":1,"revision":2,"patches":[{"path":["threadRuntimeStatus","type"],"value":"idle","Value":"active","op":"replace"}]}`)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, _ := largeFrameConnection(strings.NewReader(tc.body), len(tc.body))
			budget := newDesktopFrameBudget(1, time.Second)
			published := false
			err := c.readBudgeted(t.Context(), budget, func(desktopEnvelope) error {
				published = true
				return nil
			})
			if err == nil || published || len(budget.slots) != 0 {
				t.Fatalf("malformed input reached projection or retained a permit: err=%v published=%v slots=%d", err, published, len(budget.slots))
			}
		})
	}
}

func TestDesktopSubscriptionLargeFrameNodeAndWireBounds(t *testing.T) {
	t.Run("node bound applies to ignored content", func(t *testing.T) {
		const nodes = 2_000_001
		prefix := `{"ignored":[`
		body, size := largeFrameSnapshotBody(prefix, `0,`, `0]}`, nodes)
		c, _ := largeFrameConnection(body, size)
		budget := newDesktopFrameBudget(1, 5*time.Second)
		consumed := false
		err := c.readBudgeted(t.Context(), budget, func(desktopEnvelope) error { consumed = true; return nil })
		if err == nil || consumed || len(budget.slots) != 0 {
			t.Fatalf("ignored nodes bypassed bounds: err=%v consumed=%v slots=%d", err, consumed, len(budget.slots))
		}
	})
	t.Run("wire rejection precedes occupied budget", func(t *testing.T) {
		const wireLimit = 128 * 1024 * 1024
		c, source := largeFrameConnection(strings.NewReader(""), wireLimit+1)
		budget := newDesktopFrameBudget(1, time.Second)
		if err := budget.acquire(t.Context()); err != nil {
			t.Fatal(err)
		}
		defer budget.release()
		ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
		defer cancel()
		err := c.readBudgeted(ctx, budget, func(desktopEnvelope) error { t.Error("oversized input reached projection"); return nil })
		if !errors.Is(err, errDesktopFrameTooLarge) || source.readBytes != 4 || len(budget.slots) != 1 {
			t.Fatalf("oversized wire input consumed body/budget: err=%v bytes=%d slots=%d", err, source.readBytes, len(budget.slots))
		}
	})
}

func largeFrameApplyString(t *testing.T, projection *desktopProjection, body string) protocol.DesktopObservation {
	t.Helper()
	c, _ := largeFrameConnection(strings.NewReader(body), len(body))
	observation, err := largeFrameApply(t, c, newDesktopFrameBudget(1, time.Second), projection)
	if err != nil {
		t.Fatal(err)
	}
	return observation
}

func largeFrameCanonicalSeed(t *testing.T, projection *desktopProjection) {
	t.Helper()
	active := historyTestTurn("active")
	active["status"] = "inProgress"
	state := historyTestState(true, active)
	state["latestModel"], state["latestCollaborationMode"] = "fallback-model", nil
	encoded, err := json.Marshal(map[string]any{"type": "snapshot", "revision": 1, "conversationState": state})
	if err != nil {
		t.Fatal(err)
	}
	observation := largeFrameApplyString(t, projection, largeFrameEnvelope(string(encoded)))
	if observation.ActiveTurnID != "active" || observation.Model != "fallback-model" {
		t.Fatalf("canonical seed lost identity or model: %+v", observation)
	}
}

func TestDesktopSubscriptionLargeFramePatchFieldOrderAndCanonicalMembership(t *testing.T) {
	for _, valueFirst := range []bool{false, true} {
		name := "path first"
		if valueFirst {
			name = "value first"
		}
		t.Run(name, func(t *testing.T) {
			projection := &desktopProjection{owner: "owner"}
			largeFrameCanonicalSeed(t, projection)
			patch := `{"path":["latestCollaborationMode"],"op":"replace","value":false}`
			if valueFirst {
				patch = `{"value":false,"path":["latestCollaborationMode"],"op":"replace"}`
			}
			observation := largeFrameApplyString(t, projection, largeFrameEnvelope(`{"type":"patches","baseRevision":1,"revision":2,"patches":[`+patch+`]} `))
			if observation.Model != "" || observation.ActiveTurnID != "active" {
				t.Fatalf("invalid override authorized model fallback or lost turn: %+v", observation)
			}
			patch = `{"path":["latestCollaborationMode"],"op":"replace","value":null}`
			if valueFirst {
				patch = `{"value":null,"op":"replace","path":["latestCollaborationMode"]}`
			}
			observation = largeFrameApplyString(t, projection, largeFrameEnvelope(`{"type":"patches","baseRevision":2,"revision":3,"patches":[`+patch+`]} `))
			if observation.Model != "fallback-model" || observation.ActiveTurnID != "active" {
				t.Fatalf("null override did not restore model fallback: %+v", observation)
			}
			observation = largeFrameApplyString(t, projection, largeFrameEnvelope(`{"type":"patches","baseRevision":3,"revision":4,"patches":[{"op":"remove","path":["turnHistory","history","islands",0,"entries",0]}]}`))
			if observation.ActiveTurnID != "" || observation.Status != "active" || observation.Revision != 4 {
				t.Fatalf("removed membership retained exact-turn proof: %+v", observation)
			}
		})
	}
}

func TestDesktopSubscriptionLargeFrameValueBeforePathIgnoresHugeScalar(t *testing.T) {
	projection := &desktopProjection{owner: "owner"}
	largeFrameCanonicalSeed(t, projection)
	prefix := `{"type":"broadcast","method":"thread-stream-state-changed","version":11,"sourceClientId":"owner","targetClientIds":["large-client"],"params":{"conversationId":"session","hostId":"local","change":{"type":"patches","baseRevision":1,"revision":2,"patches":[{"value":"`
	suffix := `","path":["turnHistory","history","entitiesByKey","k","items",0,"text"],"op":"replace"},{"value":"idle","op":"replace","path":["threadRuntimeStatus","type"]}]}}}`
	body, size := largeFrameSnapshotBody(prefix, "x", suffix, desktopInboundFrameLimit+1024)
	c, _ := largeFrameConnection(body, size)
	observation, err := largeFrameApply(t, c, newDesktopFrameBudget(1, 5*time.Second), projection)
	if err != nil || observation.Status != "idle" || observation.ActiveTurnID != "active" || observation.Revision != 2 {
		t.Fatalf("value-before-path candidate overflow contaminated selected metadata: err=%v observation=%+v", err, observation)
	}
}

func TestDesktopSubscriptionLargeFrameRootValueBeforePathSkipsHugeScalar(t *testing.T) {
	projection := &desktopProjection{owner: "owner", initialized: true, revision: 1, status: "active"}
	prefix := `{"type":"broadcast","method":"thread-stream-state-changed","version":11,"sourceClientId":"owner","targetClientIds":["large-client"],"params":{"conversationId":"session","hostId":"local","change":{"type":"patches","baseRevision":1,"revision":2,"patches":[{"value":{"id":"session","hostId":"local","threadRuntimeStatus":{"type":"idle"},"latestModel":"new-model","instructions":"`
	suffix := `","turns":[{"turnId":"new-active","status":"inProgress"}]},"path":[],"op":"replace"}]}}}`
	body, size := largeFrameSnapshotBody(prefix, "x", suffix, desktopInboundFrameLimit+1024)
	c, _ := largeFrameConnection(body, size)
	observation, err := largeFrameApply(t, c, newDesktopFrameBudget(1, 5*time.Second), projection)
	if err != nil || observation.Status != "idle" || observation.Model != "new-model" || observation.ActiveTurnID != "new-active" || observation.Revision != 2 {
		t.Fatalf("unselected candidate invalidated valid root value: err=%v observation=%+v", err, observation)
	}
}

func TestDesktopSubscriptionLargeFrameRootPatchAndLateInvalidPatch(t *testing.T) {
	projection := &desktopProjection{owner: "owner"}
	largeFrameCanonicalSeed(t, projection)
	observation := largeFrameApplyString(t, projection, largeFrameEnvelope(`{"type":"patches","baseRevision":1,"revision":2,"patches":[{"value":{"id":"session","hostId":"local","threadRuntimeStatus":{"type":"idle"},"latestModel":"new-model","turns":[{"turnId":"new-active","status":"inProgress","items":[{"text":"discard"}]}]},"path":[],"op":"replace"}]}`))
	if observation.Status != "idle" || observation.Model != "new-model" || observation.ActiveTurnID != "new-active" || observation.Revision != 2 {
		t.Fatalf("root patch lost projected state: %+v", observation)
	}
	body := largeFrameEnvelope(`{"type":"patches","baseRevision":2,"revision":3,"patches":[{"op":"replace","path":["threadRuntimeStatus","type"],"value":"active"},{"op":"invalid","path":["latestModel"],"value":"wrong"}]}`)
	c, _ := largeFrameConnection(strings.NewReader(body), len(body))
	if _, err := largeFrameApply(t, c, newDesktopFrameBudget(1, time.Second), projection); err == nil || projection.status != "idle" || projection.revision != 2 || projection.latestModel != "new-model" {
		t.Fatalf("late invalid patch partially committed: err=%v status=%s revision=%d model=%s", err, projection.status, projection.revision, projection.latestModel)
	}
}

type largeFrameCancelReader struct {
	reader io.Reader
	cancel context.CancelFunc
	read   int
}

func (r *largeFrameCancelReader) Read(p []byte) (int, error) {
	n, err := r.reader.Read(p)
	r.read += n
	if r.read >= 64*1024 {
		r.cancel()
	}
	return n, err
}

func TestDesktopSubscriptionLargeFrameCancellationReleasesBudget(t *testing.T) {
	body, size := largeFrameSnapshotBody(`{"ignored":"`, "x", `"}`, 1024*1024)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	c, _ := largeFrameConnection(&largeFrameCancelReader{reader: body, cancel: cancel}, size)
	budget := newDesktopFrameBudget(1, time.Second)
	consumed := false
	err := c.readBudgeted(ctx, budget, func(desktopEnvelope) error { consumed = true; return nil })
	if !errors.Is(err, context.Canceled) || consumed || len(budget.slots) != 0 {
		t.Fatalf("canceled scan reached projection or retained permit: err=%v consumed=%v slots=%d", err, consumed, len(budget.slots))
	}
}

func TestDesktopSubscriptionLargeFrameMetadataOverflowRevokesOnlyTurnProof(t *testing.T) {
	prefix := `{"type":"broadcast","method":"thread-stream-state-changed","version":11,"sourceClientId":"owner","targetClientIds":["large-client"],"params":{"conversationId":"session","hostId":"local","change":{"type":"snapshot","revision":1,"conversationState":{"id":"session","hostId":"local","threadRuntimeStatus":{"type":"active"},"latestModel":"fallback-model","turns":[{"turnId":"`
	body, size := largeFrameSnapshotBody(prefix, "x", `","status":"inProgress"}]}}}}`, desktopObservedTurnMetadataLimit+512)
	c, _ := largeFrameConnection(body, size)
	projection := &desktopProjection{owner: "owner"}
	observation, err := largeFrameApply(t, c, newDesktopFrameBudget(1, time.Second), projection)
	if err != nil || observation.Status != "active" || observation.Model != "fallback-model" || observation.ActiveTurnID != "" || len(projection.turnMetadata) != 0 {
		t.Fatalf("overflow granted proof or discarded scalar state: err=%v observation=%+v retained=%d", err, observation, len(projection.turnMetadata))
	}
}

func TestDesktopSubscriptionLargeFrameBadTargetPreservesHealthySubscription(t *testing.T) {
	badClosed := make(chan struct{})
	path, waitIdle := isolationFixture(t, func(c *desktopConn, id string) error {
		if err := c.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
			return err
		}
		if id == "bad" {
			defer close(badClosed)
			prefix := fmt.Sprintf(`{"type":"broadcast","method":"thread-stream-state-changed","version":11,"sourceClientId":"owner-bad","targetClientIds":[%q],"params":{"conversationId":"bad","hostId":"local","change":{"type":"snapshot","revision":1,"conversationState":{"id":"bad","hostId":"local","threadRuntimeStatus":{"type":"idle"},"ignored":"`, c.clientID)
			body, size := largeFrameSnapshotBody(prefix, "x", `"}}}}!`, desktopInboundFrameLimit+1024)
			var header [4]byte
			binary.LittleEndian.PutUint32(header[:], uint32(size))
			if _, err := io.Copy(c, io.MultiReader(strings.NewReader(string(header[:])), body)); err != nil {
				return err
			}
			return isolationUnfollowOrClose(c, id)
		}
		if err := isolationSnapshot(c, id); err != nil {
			return err
		}
		select {
		case <-badClosed:
		case <-time.After(10 * time.Second):
			return errors.New("malformed large target was not independently revoked")
		}
		if err := isolationState(c, id, "owner-"+id, desktopPatchChange(1, 2,
			map[string]any{"op": "replace", "path": []any{"threadRuntimeStatus", "type"}, "value": "idle"})); err != nil {
			return err
		}
		return isolationUnfollowOrClose(c, id)
	})
	observer := NewDesktopObserver(path)
	observer.frameBudget = newDesktopFrameBudget(2, 10*time.Second)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	var badLive, healthyLive, healthyLost, healthyAdvanced bool
	err := observer.Watch(ctx, []string{"bad", "healthy"}, func(id string, observation protocol.DesktopObservation) {
		if id == "bad" {
			badLive = badLive || observation.Availability == "available"
			return
		}
		if healthyLive && observation.Availability != "available" && ctx.Err() == nil {
			healthyLost = true
		}
		healthyLive = healthyLive || observation.Availability == "available"
		if observation.Availability == "available" && observation.Status == "idle" && observation.Revision == 2 {
			healthyAdvanced = true
			cancel()
		}
	})
	if !errors.Is(err, context.Canceled) || badLive || healthyLost || !healthyAdvanced || len(observer.frameBudget.slots) != 0 {
		t.Fatalf("malformed large frame contaminated healthy target: err=%v badLive=%v healthyLost=%v advanced=%v slots=%d", err, badLive, healthyLost, healthyAdvanced, len(observer.frameBudget.slots))
	}
	waitIdle()
}

func TestDesktopSubscriptionLargeFrameReaderStopsAtFrameBoundary(t *testing.T) {
	first := largeFrameEnvelope(`{"type":"snapshot","revision":1,"conversationState":{"id":"session","hostId":"local","threadRuntimeStatus":{"type":"active"},"ignored":"雪\ud83d\ude00"}}`)
	second := largeFrameEnvelope(`{"type":"patches","baseRevision":1,"revision":2,"patches":[{"op":"replace","path":["threadRuntimeStatus","type"],"value":"idle"}]}`)
	framed := func(body string) string {
		var header [4]byte
		binary.LittleEndian.PutUint32(header[:], uint32(len(body)))
		return string(header[:]) + body
	}
	source := &largeFrameReaderConn{reader: strings.NewReader(framed(first) + framed(second))}
	c := &desktopConn{Conn: source, clientID: largeFrameTestClient}
	projection := &desktopProjection{owner: "owner"}
	budget := newDesktopFrameBudget(1, time.Second)
	observation, err := largeFrameApply(t, c, budget, projection)
	if err != nil || observation.Status != "active" || source.readBytes != len(first)+4 {
		t.Fatalf("first frame overread or rejected valid Unicode: err=%v observation=%+v read=%d", err, observation, source.readBytes)
	}
	observation, err = largeFrameApply(t, c, budget, projection)
	if err != nil || observation.Status != "idle" || observation.Revision != 2 || source.readBytes != len(first)+len(second)+8 || len(budget.slots) != 0 {
		t.Fatalf("second frame was consumed by the first projection: err=%v observation=%+v read=%d slots=%d", err, observation, source.readBytes, len(budget.slots))
	}
}

func TestDesktopSubscriptionLargeFrameBoundsLiveObjectKeys(t *testing.T) {
	var body strings.Builder
	body.WriteString(`{"ignored":{`)
	for index := range desktopJSONActiveKeyLimit + 1 {
		if index != 0 {
			body.WriteByte(',')
		}
		fmt.Fprintf(&body, `"k%d":0`, index)
	}
	body.WriteString(`}}`)
	c, _ := largeFrameConnection(strings.NewReader(body.String()), body.Len())
	budget := newDesktopFrameBudget(1, desktopFrameBodyTimeout)
	consumed := false
	err := c.readBudgeted(t.Context(), budget, func(desktopEnvelope) error { consumed = true; return nil })
	if !errors.Is(err, errDesktopSubscriptionJSONBounds) || consumed || len(budget.slots) != 0 {
		t.Fatalf("ignored object exceeded key memory budget: err=%v consumed=%v slots=%d", err, consumed, len(budget.slots))
	}
	// Completed objects release their namespaces; ordinary repeated items must
	// not inherit the simultaneous-key limit as a cumulative item count.
	reader, size := largeFrameSnapshotBody(`{"ignored":[`, `{"x":0},`, `{}]}`, desktopJSONActiveKeyLimit+1)
	c, _ = largeFrameConnection(reader, size)
	if err := c.readBudgeted(t.Context(), budget, func(desktopEnvelope) error { return nil }); err != nil || len(budget.slots) != 0 {
		t.Fatalf("completed object key namespaces were retained: err=%v slots=%d", err, len(budget.slots))
	}
}
