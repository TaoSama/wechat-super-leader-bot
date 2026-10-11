package terminal

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	MaxDeliveryPromptBytes = 64 << 10
	deliveryReceiptKind    = "terminal-input-written"
	deliveryPromptMethod   = "agent.prompt"
)

var deliveryRequestPattern = regexp.MustCompile(`^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-4[a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$`)

// DeliveryIdentity is a value snapshot for a future private durable claim. It
// contains private endpoint/session identifiers and is not a public receipt.
type DeliveryIdentity struct {
	SessionID, RequestID, Endpoint                    string
	PaneID, TerminalID, WorkspaceID, TabID, Provider  string
	AgentSessionSource, AgentSessionAgent             string
	AgentSessionKind, AgentSessionValue, PromptSHA256 string
	Revision                                          uint64
}

// DeliveryReceipt proves only that terminal input was written and checked.
// It supplies neither a native turn nor task-completion evidence.
type DeliveryReceipt struct {
	Kind             string `json:"kind"`
	SessionID        string `json:"sessionId"`
	RequestID        string `json:"requestId"`
	PromptSHA256     string `json:"promptSHA256"`
	ResponseRevision uint64 `json:"responseRevision"`
	ObservedRevision uint64 `json:"observedRevision"`
}

// DeliveryError never includes the prompt, endpoint, native session or host
// response. An uncertain error must never authorize automatic resubmission.
type DeliveryError struct {
	Attempted bool
	Uncertain bool
	reason    string
}

func (e *DeliveryError) Error() string { return e.reason }

type DeliveryController struct{ observer *Observer }

func NewDeliveryController(observer *Observer) *DeliveryController {
	return &DeliveryController{observer: observer}
}

// PreparedDelivery owns one bounded connection and permits one Dispatch call.
// This in-memory guard is not persistent command idempotency.
type PreparedDelivery struct {
	identity          DeliveryIdentity
	prompt            string
	bound             binding
	client            *rpcClient
	ctx               context.Context
	cancel            context.CancelFunc
	deadline          time.Time
	dispatched        atomic.Bool
	mutationAttempted atomic.Bool
	closed            atomic.Bool
	writeGate         sync.Mutex
	closeOnce         sync.Once
	closeErr          error
}

func deliveryFailure(reason string, attempted bool) *DeliveryError {
	return &DeliveryError{Attempted: attempted, Uncertain: attempted, reason: reason}
}

func validDeliveryPrompt(prompt string) bool {
	return strings.TrimSpace(prompt) != "" && len(prompt) <= MaxDeliveryPromptBytes && utf8.ValidString(prompt) &&
		strings.IndexFunc(prompt, func(r rune) bool { return unicode.IsControl(r) && r != '\n' && r != '\t' }) < 0
}

// PrepareDelivery has no input side effects. Its total budget includes the time
// the caller spends retaining the prepared object before Dispatch.
func (d *DeliveryController) PrepareDelivery(ctx context.Context, sessionID, requestID, prompt string) (*PreparedDelivery, error) {
	if d == nil || d.observer == nil {
		return nil, deliveryFailure("terminal delivery observer is unavailable", false)
	}
	o := d.observer
	preparedCtx, cancel := context.WithTimeout(ctx, o.operationTimeout)
	if o.validate() != nil || !sessionPattern.MatchString(sessionID) || !deliveryRequestPattern.MatchString(requestID) || !validDeliveryPrompt(prompt) {
		cancel()
		return nil, deliveryFailure("terminal delivery arguments are invalid", false)
	}
	o.mu.Lock()
	bound, exists := o.bindings[sessionID]
	if exists && bound.Session != nil {
		session := *bound.Session
		bound.Session = &session
	}
	o.mu.Unlock()
	if !exists || bound.Session == nil {
		cancel()
		return nil, deliveryFailure("terminal delivery session was not discovered", false)
	}
	client, err := o.connect(preparedCtx)
	if err != nil {
		cancel()
		return nil, deliveryFailure("terminal delivery preparation connection failed", false)
	}
	p := &PreparedDelivery{prompt: prompt, bound: bound, client: client, ctx: preparedCtx, cancel: cancel}
	p.deadline, _ = preparedCtx.Deadline()
	info, err := client.getAgentContext(preparedCtx, bound.Pane)
	if err != nil || info == nil || !sameBinding(bound, info.binding()) || !deliveryReady(info) || preparedCtx.Err() != nil {
		if closeErr := p.Close(); closeErr != nil {
			return nil, deliveryFailure("terminal delivery preparation and cleanup failed", false)
		}
		return nil, deliveryFailure("terminal delivery target is unavailable or not ready", false)
	}
	digest := sha256.Sum256([]byte(prompt))
	p.identity = DeliveryIdentity{SessionID: sessionID, RequestID: requestID, Endpoint: o.socket,
		PaneID: bound.Pane, TerminalID: bound.Terminal, WorkspaceID: bound.Workspace, TabID: bound.Tab, Provider: bound.Provider,
		AgentSessionSource: bound.Session.Source, AgentSessionAgent: bound.Session.Agent,
		AgentSessionKind: bound.Session.Kind, AgentSessionValue: bound.Session.Value,
		Revision: *info.Revision, PromptSHA256: fmt.Sprintf("%x", digest)}
	return p, nil
}

func deliveryReady(info *agentInfo) bool {
	return (info.Status == "idle" || info.Status == "done") &&
		bytes.Equal(bytes.TrimSpace(info.InteractiveReady), []byte("true")) &&
		bytes.Equal(bytes.TrimSpace(info.LaunchPending), []byte("false")) &&
		bytes.Equal(bytes.TrimSpace(info.ScreenDetectionSkipped), []byte("false"))
}

func (p *PreparedDelivery) Identity() DeliveryIdentity { return p.identity }

func (p *PreparedDelivery) failure(reason string) error {
	return deliveryFailure(reason, p.mutationAttempted.Load())
}

// beginWrite linearizes Close against authorization of the first mutating
// Write. Close may still win before the actual Write; that case is conservatively
// attempted too. Even Write(0, err) is an attempted input delivery.
func (p *PreparedDelivery) beginWrite(ctx context.Context) error {
	p.writeGate.Lock()
	defer p.writeGate.Unlock()
	if p.closed.Load() || p.ctx.Err() != nil || ctx.Err() != nil || !time.Now().Before(p.deadline) {
		return p.failure("terminal delivery was closed or canceled before input")
	}
	p.mutationAttempted.Store(true)
	return nil
}

func (p *PreparedDelivery) promptAgent(ctx context.Context) (*agentInfo, error) {
	var response struct {
		Type  string     `json:"type"`
		Agent *agentInfo `json:"agent"`
	}
	_, err := p.client.roundTrip(ctx, deliveryPromptMethod, p.identity.RequestID, struct {
		Target string `json:"target"`
		Text   string `json:"text"`
	}{p.identity.PaneID, p.prompt}, &response, func() error { return p.beginWrite(ctx) })
	if err != nil || response.Type != "agent_prompted" {
		return nil, p.failure("terminal delivery input receipt is unavailable or invalid")
	}
	info, err := validateAgentInfo(response.Agent, p.identity.PaneID)
	if err != nil || info == nil || !sameBinding(p.bound, info.binding()) || *info.Revision < p.identity.Revision {
		return nil, p.failure("terminal delivery input receipt target changed")
	}
	return info, nil
}

func (p *PreparedDelivery) Dispatch(ctx context.Context) (DeliveryReceipt, error) {
	if !p.dispatched.CompareAndSwap(false, true) {
		// Another call may still be running. Conservatively preserve its possible
		// write instead of presenting the duplicate as a safe zero-input failure.
		return DeliveryReceipt{}, deliveryFailure("terminal delivery already-attempted: preparation cannot be reused", true)
	}
	if ctx.Err() != nil || p.ctx.Err() != nil || p.closed.Load() || !time.Now().Before(p.deadline) {
		return DeliveryReceipt{}, p.failure("terminal delivery expired, canceled or closed before dispatch")
	}
	deadline := p.deadline
	if callerDeadline, ok := ctx.Deadline(); ok && callerDeadline.Before(deadline) {
		deadline = callerDeadline
	}
	effectiveCtx, cancel := context.WithDeadline(p.ctx, deadline)
	// Cancel the owned preparation context as well, so a blocked socket read
	// is interrupted immediately for either layer of caller cancellation.
	stopCaller := context.AfterFunc(ctx, p.cancel)
	stopEffective := context.AfterFunc(effectiveCtx, p.cancel)
	defer func() { stopCaller(); stopEffective(); cancel() }()
	before, err := p.client.getAgentContext(effectiveCtx, p.identity.PaneID)
	if err != nil || before == nil || !sameBinding(p.bound, before.binding()) ||
		*before.Revision != p.identity.Revision || !deliveryReady(before) {
		return DeliveryReceipt{}, p.failure("terminal delivery preflight target changed or is not ready")
	}
	response, err := p.promptAgent(effectiveCtx)
	if err != nil {
		return DeliveryReceipt{}, err
	}
	after, err := p.client.getAgentContext(effectiveCtx, p.identity.PaneID)
	if err != nil || after == nil || !sameBinding(p.bound, after.binding()) || *after.Revision < *response.Revision ||
		effectiveCtx.Err() != nil || ctx.Err() != nil || p.closed.Load() {
		return DeliveryReceipt{}, p.failure("terminal delivery postflight target or evidence changed")
	}
	return DeliveryReceipt{Kind: deliveryReceiptKind, SessionID: p.identity.SessionID, RequestID: p.identity.RequestID,
		PromptSHA256: p.identity.PromptSHA256, ResponseRevision: *response.Revision, ObservedRevision: *after.Revision}, nil
}

// Close releases the owned connection exactly once. A cleanup failure after
// input cannot be interpreted as authorization to send the prompt again.
func (p *PreparedDelivery) Close() error {
	p.closeOnce.Do(func() {
		p.writeGate.Lock()
		p.closed.Store(true)
		p.writeGate.Unlock()
		defer p.cancel()
		if err := p.client.close(); err != nil {
			p.closeErr = p.failure("terminal delivery connection cleanup failed")
		}
	})
	return p.closeErr
}
