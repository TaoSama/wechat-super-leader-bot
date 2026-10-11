package terminal

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

func discoveredDelivery(t *testing.T, h *regressionHost) (*DeliveryController, string) {
	t.Helper()
	o := NewObserver(h.socket, []string{"w1:p1"})
	sessions, err := o.DiscoverSessions(context.Background())
	if err != nil || len(sessions) != 1 {
		t.Fatalf("discover: sessions=%d err=%v", len(sessions), err)
	}
	return NewDeliveryController(o), sessions[0].ID
}

func closeDelivery(t *testing.T, p *PreparedDelivery) {
	t.Helper()
	if err := p.Close(); err != nil {
		t.Error(err)
	}
}

func TestDeliveryExactInputAndPublicReceipt(t *testing.T) {
	const prompt = "  中文原文\n\t第二行 e\u0301\n "
	h := newRegressionHost(t, func(r testRequest, n int) []byte {
		if r.Method == deliveryPromptMethod {
			var params map[string]string
			if err := json.Unmarshal(r.Params, &params); err != nil {
				t.Error(err)
			}
			if len(params) != 2 || params["target"] != "w1:p1" || params["text"] != prompt || r.ID != regressionRequestID {
				t.Error("input params or request ID changed")
			}
		}
		if r.Method == "agent.get" && n == 4 {
			a := regressionAgent()
			a["agent_status"] = "working"
			a["interactive_ready"] = false
			a["revision"] = 11
			return encodedResponse(t, r, map[string]any{"type": "agent_info", "agent": a})
		}
		return regressionResponse(t, r)
	})
	d, id := discoveredDelivery(t, h)
	p, err := d.PrepareDelivery(context.Background(), id, regressionRequestID, prompt)
	if err != nil {
		t.Fatal(err)
	}
	defer closeDelivery(t, p)
	if h.count(deliveryPromptMethod) != 0 {
		t.Fatal("prepare sent input")
	}
	identity := p.Identity()
	digest := sha256.Sum256([]byte(prompt))
	if identity.PromptSHA256 != fmt.Sprintf("%x", digest) || identity.Endpoint != h.socket || identity.AgentSessionValue != "/no-such-private-transcript" || identity.Revision != 10 {
		t.Fatalf("incorrect frozen identity: %+v", identity)
	}
	identity.Endpoint, identity.AgentSessionValue, identity.PromptSHA256 = "changed", "changed", "changed"
	receipt, err := p.Dispatch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Kind != deliveryReceiptKind || receipt.ResponseRevision != 10 || receipt.ObservedRevision != 11 || receipt.PromptSHA256 != fmt.Sprintf("%x", digest) {
		t.Fatalf("invalid receipt: %+v", receipt)
	}
	data, err := json.Marshal(receipt)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{h.socket, prompt, "/no-such-private-transcript", "turnId", "completed", "output", "Endpoint", "Identity"} {
		if strings.Contains(string(data), forbidden) {
			t.Fatalf("public receipt included private or completion data: %s", forbidden)
		}
	}
	secondReceipt, secondErr := p.Dispatch(context.Background())
	assertRegressionFailure(t, secondReceipt, secondErr, true)
	if !strings.Contains(secondErr.Error(), "already-attempted") || h.count(deliveryPromptMethod) != 1 {
		t.Fatal("duplicate dispatch lost previous attempt state or repeated input")
	}
	if err := p.client.call(deliveryPromptMethod, struct{}{}, new(any)); err == nil || h.count(deliveryPromptMethod) != 1 {
		t.Fatal("read-only API admitted prompt")
	}
}

func TestDeliveryInvalidArgumentsDoNotConnect(t *testing.T) {
	h := newRegressionHost(t, func(r testRequest, _ int) []byte { return regressionResponse(t, r) })
	d, id := discoveredDelivery(t, h)
	baseline := h.count("ping")
	cases := []struct{ name, session, request, prompt string }{
		{"short-session", "terminal:short", regressionRequestID, "safe"},
		{"unknown-session", SessionPrefix + strings.Repeat("a", 43), regressionRequestID, "safe"},
		{"non-v4", id, "017de777-b296-12cb-a229-d3d7af3038e5", "safe"},
		{"bad-variant", id, "017de777-b296-42cb-7229-d3d7af3038e5", "safe"},
		{"uuid-suffix", id, regressionRequestID + "x", "safe"},
		{"empty", id, regressionRequestID, ""},
		{"whitespace-only", id, regressionRequestID, " \n\t\u3000"},
		{"utf8", id, regressionRequestID, string([]byte{0xff})},
		{"cr", id, regressionRequestID, "a\rb"},
		{"escape", id, regressionRequestID, "a\x1b[31m"},
		{"nul", id, regressionRequestID, "a\x00b"},
		{"del", id, regressionRequestID, "a\x7fb"},
		{"unicode-control", id, regressionRequestID, "a\u0085b"},
		{"oversized", id, regressionRequestID, strings.Repeat("x", MaxDeliveryPromptBytes+1)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p, err := d.PrepareDelivery(context.Background(), tc.session, tc.request, tc.prompt)
			if p != nil {
				closeDelivery(t, p)
				t.Fatal("invalid input was prepared")
			}
			assertRegressionFailure(t, DeliveryReceipt{}, err, false)
			if h.count("ping") != baseline || h.count(deliveryPromptMethod) != 0 {
				t.Fatal("invalid input touched the host")
			}
		})
	}
	for _, prompt := range []string{" \n\t x", strings.Repeat("x", MaxDeliveryPromptBytes)} {
		p, err := d.PrepareDelivery(context.Background(), id, regressionRequestID, prompt)
		if err != nil {
			t.Fatal("valid boundary prompt:", err)
		}
		closeDelivery(t, p)
	}
	_, err := NewDeliveryController(nil).PrepareDelivery(context.Background(), id, regressionRequestID, "safe")
	assertRegressionFailure(t, DeliveryReceipt{}, err, false)
}

func TestDeliveryRequiresExplicitReady(t *testing.T) {
	cases := []struct {
		name string
		edit func(map[string]any)
	}{
		{"working", func(a map[string]any) { a["agent_status"] = "working" }},
		{"blocked", func(a map[string]any) { a["agent_status"] = "blocked" }},
		{"unknown", func(a map[string]any) { a["agent_status"] = "unknown" }},
		{"not-ready", func(a map[string]any) { a["interactive_ready"] = false }},
		{"pending", func(a map[string]any) { a["launch_pending"] = true }},
		{"detection-skipped", func(a map[string]any) { a["screen_detection_skipped"] = true }},
		{"ready-missing", func(a map[string]any) { delete(a, "interactive_ready") }},
		{"pending-missing", func(a map[string]any) { delete(a, "launch_pending") }},
		{"detection-missing", func(a map[string]any) { delete(a, "screen_detection_skipped") }},
	}
	for _, phase := range []string{"prepare", "dispatch"} {
		for _, tc := range cases {
			t.Run(phase+"/"+tc.name, func(t *testing.T) {
				h := newRegressionHost(t, func(r testRequest, n int) []byte {
					if r.Method == "agent.get" && ((phase == "prepare" && n == 2) || (phase == "dispatch" && n == 3)) {
						a := regressionAgent()
						tc.edit(a)
						return encodedResponse(t, r, map[string]any{"type": "agent_info", "agent": a})
					}
					return regressionResponse(t, r)
				})
				d, id := discoveredDelivery(t, h)
				p, err := d.PrepareDelivery(context.Background(), id, regressionRequestID, "safe")
				if phase == "dispatch" {
					if err != nil {
						t.Fatal(err)
					}
					defer closeDelivery(t, p)
					_, err = p.Dispatch(context.Background())
				}
				assertRegressionFailure(t, DeliveryReceipt{}, err, false)
				if h.count(deliveryPromptMethod) != 0 {
					t.Fatal("non-ready target received input")
				}
			})
		}
	}
	t.Run("done-ready", func(t *testing.T) {
		h := newRegressionHost(t, func(r testRequest, _ int) []byte {
			if r.Method == "agent.get" {
				a := regressionAgent()
				a["agent_status"] = "done"
				return encodedResponse(t, r, map[string]any{"type": "agent_info", "agent": a})
			}
			return regressionResponse(t, r)
		})
		p := prepareRegression(t, h, context.Background())
		if _, err := p.Dispatch(context.Background()); err != nil {
			t.Fatal(err)
		}
	})
}

func TestDeliveryBadPromptReceiptIsUncertain(t *testing.T) {
	for _, mode := range []string{"wrong-type", "unknown-field", "null-agent", "duplicate-key", "result-and-error", "host-error", "regressed-revision", "rebound", "trailing-json"} {
		t.Run(mode, func(t *testing.T) {
			h := newRegressionHost(t, func(r testRequest, _ int) []byte {
				if r.Method != deliveryPromptMethod {
					return regressionResponse(t, r)
				}
				a := regressionAgent()
				result := map[string]any{"type": "agent_prompted", "agent": a}
				switch mode {
				case "wrong-type":
					result["type"] = "agent_info"
				case "unknown-field":
					result["completed"] = true
				case "null-agent":
					result["agent"] = nil
				case "duplicate-key":
					return []byte(fmt.Sprintf("{\"id\":%q,\"id\":%q,\"result\":{}}\n", r.ID, r.ID))
				case "result-and-error":
					return []byte(fmt.Sprintf("{\"id\":%q,\"result\":{},\"error\":{\"code\":\"private\",\"message\":\"private\"}}\n", r.ID))
				case "host-error":
					return []byte(fmt.Sprintf("{\"id\":%q,\"error\":{\"code\":\"private\",\"message\":%q}}\n", r.ID, hPrivateError))
				case "regressed-revision":
					a["revision"] = 9
				case "rebound":
					a["agent_session"].(map[string]any)["value"] = "replacement"
				case "trailing-json":
					return append(regressionResponse(t, r)[:len(regressionResponse(t, r))-1], []byte("{}\n")...)
				}
				return encodedResponse(t, r, result)
			})
			p := prepareRegression(t, h, context.Background())
			receipt, err := p.Dispatch(context.Background())
			assertRegressionFailure(t, receipt, err, true)
			if strings.Contains(err.Error(), hPrivateError) || h.count(deliveryPromptMethod) != 1 {
				t.Fatal("bad receipt leaked private error or retried")
			}
		})
	}
}

const hPrivateError = "private host prompt or transcript"

type deliveryFaultConn struct {
	net.Conn
	zeroWrite bool
	closeFail bool
}

func (c *deliveryFaultConn) Write(data []byte) (int, error) {
	var request testRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return 0, err
	}
	if c.zeroWrite && request.Method == deliveryPromptMethod {
		return 0, io.ErrUnexpectedEOF
	}
	return c.Conn.Write(data)
}

func (c *deliveryFaultConn) Close() error {
	if err := c.Conn.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
		return err
	}
	if c.closeFail {
		return errors.New(hPrivateError)
	}
	return nil
}

func TestDeliveryZeroWriteErrorStillUncertain(t *testing.T) {
	h := newRegressionHost(t, func(r testRequest, _ int) []byte { return regressionResponse(t, r) })
	p := prepareRegression(t, h, context.Background())
	p.client.conn = &deliveryFaultConn{Conn: p.client.conn, zeroWrite: true}
	receipt, err := p.Dispatch(context.Background())
	assertRegressionFailure(t, receipt, err, true)
	if h.count(deliveryPromptMethod) != 0 {
		t.Fatal("zero write reached host")
	}
}

func TestDeliveryCloseFailureAfterSuccessIsUncertain(t *testing.T) {
	h := newRegressionHost(t, func(r testRequest, _ int) []byte { return regressionResponse(t, r) })
	d, id := discoveredDelivery(t, h)
	p, err := d.PrepareDelivery(context.Background(), id, regressionRequestID, "safe")
	if err != nil {
		t.Fatal(err)
	}
	p.client.conn = &deliveryFaultConn{Conn: p.client.conn, closeFail: true}
	receipt, err := p.Dispatch(context.Background())
	if err != nil || receipt.Kind != deliveryReceiptKind {
		t.Fatalf("dispatch did not succeed: receipt=%+v err=%v", receipt, err)
	}
	first := p.Close()
	assertRegressionFailure(t, DeliveryReceipt{}, first, true)
	if p.Close() != first || strings.Contains(first.Error(), hPrivateError) {
		t.Fatal("close was non-idempotent or exposed original close error")
	}
	receipt, err = p.Dispatch(context.Background())
	assertRegressionFailure(t, receipt, err, true)
	if h.count(deliveryPromptMethod) != 1 {
		t.Fatal("cleanup failure allowed re-send")
	}
}

func TestDeliveryBudgetIncludesWaitingAndCancelsBlockedRead(t *testing.T) {
	t.Run("retained-preparation", func(t *testing.T) {
		h := newRegressionHost(t, func(r testRequest, _ int) []byte { return regressionResponse(t, r) })
		d, id := discoveredDelivery(t, h)
		d.observer.operationTimeout = 50 * time.Millisecond
		p, err := d.PrepareDelivery(context.Background(), id, regressionRequestID, "safe")
		if err != nil {
			t.Fatal(err)
		}
		defer closeDelivery(t, p)
		<-p.ctx.Done()
		receipt, err := p.Dispatch(context.Background())
		assertRegressionFailure(t, receipt, err, false)
		if h.count(deliveryPromptMethod) != 0 {
			t.Fatal("waiting reset total budget")
		}
	})
	for _, phase := range []string{"preflight", "prompt", "postflight"} {
		t.Run(phase, func(t *testing.T) {
			reached := make(chan struct{})
			h := newRegressionHost(t, func(r testRequest, n int) []byte {
				if (phase == "preflight" && r.Method == "agent.get" && n == 3) ||
					(phase == "prompt" && r.Method == deliveryPromptMethod) ||
					(phase == "postflight" && r.Method == "agent.get" && n == 4) {
					close(reached)
					return []byte("{\"id\":")
				}
				return regressionResponse(t, r)
			})
			p := prepareRegression(t, h, context.Background())
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			type dispatchResult struct {
				receipt DeliveryReceipt
				err     error
			}
			done := make(chan dispatchResult, 1)
			go func() {
				receipt, err := p.Dispatch(ctx)
				done <- dispatchResult{receipt, err}
			}()
			select {
			case <-reached:
			case <-time.After(time.Second):
				t.Fatal("did not reach blocked RPC")
			}
			cancel()
			select {
			case result := <-done:
				assertRegressionFailure(t, result.receipt, result.err, phase != "preflight")
			case <-time.After(time.Second):
				t.Fatal("cancel did not interrupt blocked RPC")
			}
		})
	}
}
