package appserver

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	// approvalReplayGrace bounds how long replayed requests may trail the
	// resume response and the follow-up barrier RPC on the same connection.
	approvalReplayGrace = 300 * time.Millisecond
	// approvalResolveTimeout bounds the wait for serverRequest/resolved after answering.
	approvalResolveTimeout = 5 * time.Second
)

var (
	_ codex.ApprovalReader   = (*AppServerAdapter)(nil)
	_ codex.ApprovalAnswerer = (*AppServerAdapter)(nil)
)

// approvalSubscription is a short-lived connection subscribed to one loaded
// thread. The server replays its pending requests to it; nothing is answered
// unless AnswerApproval explicitly writes one response.
type approvalSubscription struct {
	rc        *rpcConn
	events    chan serverEvent
	sessionID string
	requests  []serverEvent
	resolved  map[string]bool
}

// subscribeApprovals attaches to an already loaded thread only. An unloaded
// thread is never resumed here, because that could create a second writer.
func (a *AppServerAdapter) subscribeApprovals(ctx context.Context, sessionID string) (*approvalSubscription, error) {
	if !protocol.ValidHistoryIdentity(sessionID) || strings.HasPrefix(sessionID, "terminal:") {
		return nil, errors.New("invalid approval target identity")
	}
	events := make(chan serverEvent, serverEventBuffer)
	rc, err := a.connectWith(ctx, MaxWebSocketFrameSize, events)
	if err != nil {
		return nil, err
	}
	sub := &approvalSubscription{rc: rc, events: events, sessionID: sessionID, resolved: map[string]bool{}}
	loaded, err := rc.getLoadedSet(ctx, a.rpcTimeout)
	if err != nil {
		sub.close()
		return nil, err
	}
	if !loaded[sessionID] {
		sub.close()
		return nil, codex.ErrApprovalUnreachable
	}
	result, err := rc.call(ctx, "thread/resume", map[string]any{"threadId": sessionID, "excludeTurns": true}, a.rpcTimeout)
	if err != nil {
		sub.close()
		return nil, fmt.Errorf("%w: thread/resume failed: %v", codex.ErrApprovalUnreachable, err)
	}
	if _, err := exactSendTarget(result, sessionID); err != nil {
		sub.close()
		return nil, fmt.Errorf("thread/resume response rejected: %w", err)
	}
	// The server replays pending requests right after the resume response.
	// A second round trip plus a short grace lets them arrive before we look.
	if _, err := rc.getLoadedSet(ctx, a.rpcTimeout); err != nil {
		sub.close()
		return nil, err
	}
	sub.collect(ctx, approvalReplayGrace)
	return sub, nil
}

func (s *approvalSubscription) close() { s.rc.closeLogged() }

// collect drains events for up to wait, recording requests and resolutions.
func (s *approvalSubscription) collect(ctx context.Context, wait time.Duration) {
	timer := time.NewTimer(wait)
	defer timer.Stop()
	for {
		select {
		case event := <-s.events:
			s.record(event)
		case <-timer.C:
			return
		case <-ctx.Done():
			return
		case <-s.rc.done:
			return
		}
	}
}

func (s *approvalSubscription) record(event serverEvent) {
	if id, ok := resolvedRequestID(event, s.sessionID); ok {
		s.resolved[id] = true
		return
	}
	if event.ID != nil {
		s.requests = append(s.requests, event)
	}
}

func (s *approvalSubscription) pending() []protocol.PendingApproval {
	approvals := []protocol.PendingApproval{}
	for _, event := range s.requests {
		approval, _, ok := pendingApprovalFrom(event, s.sessionID)
		if !ok || s.resolved[approval.RequestID] {
			continue
		}
		approvals = append(approvals, approval)
		if len(approvals) == protocol.MaxPendingApprovals {
			break
		}
	}
	return approvals
}

// PendingApprovals reports the requests the server replays for a loaded thread.
// It only observes: closing the connection leaves every request pending.
func (a *AppServerAdapter) PendingApprovals(ctx context.Context, sessionID string) ([]protocol.PendingApproval, error) {
	sub, err := a.subscribeApprovals(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	defer sub.close()
	return sub.pending(), nil
}

// AnswerApproval writes exactly one accept/decline response for the replayed
// request matching (sessionID, turnID, requestID), then waits for the server to
// report it resolved. It never answers any other request and never retries.
func (a *AppServerAdapter) AnswerApproval(ctx context.Context, sessionID, turnID, requestID, decision string) error {
	if !protocol.ValidTurnID(turnID) || !protocol.ValidApprovalRequestID(requestID) {
		return errors.New("invalid approval target identity")
	}
	if decision != protocol.ApprovalAccept && decision != protocol.ApprovalDecline {
		return errors.New("approval decision must be accept or decline")
	}
	sub, err := a.subscribeApprovals(ctx, sessionID)
	if err != nil {
		return err
	}
	defer sub.close()
	var target *serverEvent
	matches := 0
	for i := range sub.requests {
		approval, _, ok := pendingApprovalFrom(sub.requests[i], sessionID)
		if ok && approval.RequestID == requestID {
			matches++
			if approval.TurnID != turnID {
				return errors.New("approval request belongs to a different turn; no decision sent")
			}
			if !approval.Answerable {
				return errors.New("this approval kind cannot be answered remotely; no decision sent")
			}
			target = &sub.requests[i]
		}
	}
	if matches > 1 {
		return errors.New("approval request id is ambiguous; no decision sent")
	}
	if target == nil || sub.resolved[requestID] {
		return codex.ErrApprovalNotPending
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := sub.rc.respond(target.ID, map[string]any{"decision": decision}); err != nil {
		if errors.Is(err, errResponseNotWritten) {
			return err
		}
		return &codex.UncertainError{Err: fmt.Errorf("approval response write uncertain: %w", err)}
	}
	if sub.awaitResolved(ctx, requestID) {
		return nil
	}
	return &codex.UncertainError{Err: errors.New("approval answer sent but resolution not confirmed; do not retry blindly")}
}

func (s *approvalSubscription) awaitResolved(ctx context.Context, requestID string) bool {
	if s.resolved[requestID] {
		return true
	}
	timer := time.NewTimer(approvalResolveTimeout)
	defer timer.Stop()
	for {
		select {
		case event := <-s.events:
			s.record(event)
			if s.resolved[requestID] {
				return true
			}
		case <-timer.C:
			return false
		case <-ctx.Done():
			return false
		case <-s.rc.done:
			return false
		}
	}
}
