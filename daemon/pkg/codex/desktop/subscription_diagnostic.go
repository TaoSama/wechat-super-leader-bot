package desktop

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
)

type desktopSubscriptionStage string

const (
	desktopSubscriptionStageAttempt      desktopSubscriptionStage = "attempt"
	desktopSubscriptionStageBudget       desktopSubscriptionStage = "budget"
	desktopSubscriptionStageConnect      desktopSubscriptionStage = "connect-initialize"
	desktopSubscriptionStageOwner        desktopSubscriptionStage = "owner-check"
	desktopSubscriptionStageFollow       desktopSubscriptionStage = "follow-write"
	desktopSubscriptionStageReadDeadline desktopSubscriptionStage = "read-deadline"
	desktopSubscriptionStageHeader       desktopSubscriptionStage = "read-header"
	desktopSubscriptionStageBody         desktopSubscriptionStage = "read-body-project-json"
	desktopSubscriptionStageApply        desktopSubscriptionStage = "apply-state"
	desktopSubscriptionStageRevoked      desktopSubscriptionStage = "revocation"
	desktopSubscriptionStageUnfollow     desktopSubscriptionStage = "cleanup-unfollow"
	desktopSubscriptionStageReset        desktopSubscriptionStage = "cleanup-read-deadline"
)

type desktopSubscriptionFailure struct {
	stage desktopSubscriptionStage
	cause error
}

func (e *desktopSubscriptionFailure) Error() string { return e.cause.Error() }
func (e *desktopSubscriptionFailure) Unwrap() error { return e.cause }

func desktopSubscriptionAt(stage desktopSubscriptionStage, err error) error {
	if err == nil {
		return nil
	}
	var marked *desktopSubscriptionFailure
	if errors.As(err, &marked) {
		return err
	}
	return &desktopSubscriptionFailure{stage: stage, cause: err}
}

// Joined failures report the first non-cleanup branch, in join order. A later
// cleanup annotation must not hide an earlier unannotated transport failure.
func desktopSubscriptionPrimary(err error, stage desktopSubscriptionStage) (desktopSubscriptionStage, error, bool) {
	if marked, ok := err.(*desktopSubscriptionFailure); ok {
		stage, cause, _ := desktopSubscriptionPrimary(marked.cause, marked.stage)
		return stage, cause, true
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		var cleanup error
		cleanupStage := stage
		for _, child := range joined.Unwrap() {
			if child == nil {
				continue
			}
			childStage, cause, _ := desktopSubscriptionPrimary(child, stage)
			if !desktopSubscriptionCleanupStage(childStage) {
				return childStage, cause, true
			}
			if cleanup == nil {
				cleanupStage, cleanup = childStage, cause
			}
		}
		if cleanup != nil {
			return cleanupStage, cleanup, true
		}
	}
	if inner := errors.Unwrap(err); inner != nil {
		if childStage, cause, found := desktopSubscriptionPrimary(inner, stage); found {
			return childStage, cause, true
		}
	}
	return stage, err, false
}

func desktopSubscriptionDiagnostic(err error) (desktopSubscriptionStage, string) {
	stage, err, _ := desktopSubscriptionPrimary(err, desktopSubscriptionStageAttempt)
	var networkError net.Error
	var operationError *net.OpError
	switch {
	case err == nil:
		return stage, "none"
	case errors.Is(err, errDesktopFrameTooLarge):
		return stage, "frame-limit"
	case errors.Is(err, context.Canceled):
		return stage, "context-canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return stage, "context-deadline"
	case errors.Is(err, errDesktopSubscriptionJSONBounds):
		return stage, "json-bound"
	case errors.Is(err, errDesktopSubscriptionJSON):
		return stage, "invalid-json"
	case errors.Is(err, errDesktopUnavailable):
		return stage, "owner-unavailable"
	case errors.Is(err, io.ErrUnexpectedEOF):
		return stage, "truncated-frame"
	case errors.Is(err, io.EOF):
		return stage, "eof"
	case errors.As(err, &networkError) && networkError.Timeout():
		return stage, "transport-timeout"
	case errors.Is(err, net.ErrClosed):
		return stage, "transport-closed"
	case errors.As(err, &operationError):
		return stage, "transport"
	default:
		return stage, "other-rejected"
	}
}

func desktopSubscriptionCleanupStage(stage desktopSubscriptionStage) bool {
	return stage == desktopSubscriptionStageUnfollow || stage == desktopSubscriptionStageReset
}

func desktopSubscriptionCleanupFailed(err error) bool {
	if err == nil {
		return false
	}
	if marked, ok := err.(*desktopSubscriptionFailure); ok {
		if desktopSubscriptionCleanupStage(marked.stage) {
			return true
		}
		return desktopSubscriptionCleanupFailed(marked.cause)
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		for _, child := range joined.Unwrap() {
			if desktopSubscriptionCleanupFailed(child) {
				return true
			}
		}
		return false
	}
	return desktopSubscriptionCleanupFailed(errors.Unwrap(err))
}

func logDesktopSubscriptionFailure(err error) {
	if err == nil {
		return
	}
	reason := "invalid-state-or-transport"
	if errors.Is(err, errDesktopFrameTooLarge) {
		reason = "frame-too-large"
	} else if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		reason = "subscription-window-ended"
	}
	stage, class := desktopSubscriptionDiagnostic(err)
	log.Printf("desktop target subscription unavailable: %s stage=%s class=%s cleanup_failed=%t", reason, stage, class, desktopSubscriptionCleanupFailed(err))
}
