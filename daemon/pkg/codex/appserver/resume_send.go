package appserver

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex/internal/threadstate"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

var _ codex.ResumeSender = (*AppServerAdapter)(nil)

func (a *AppServerAdapter) Endpoint() string { return a.socketPath }

// ResumeSend is only for an explicit, durably claimed send. It uses the existing
// configured server and preserves its writer exclusion; it never starts a server,
// creates a thread, retries a mutation, or changes settings on the target thread.
func (a *AppServerAdapter) ResumeSend(ctx context.Context, sessionID, prompt string) (string, error) {
	if !protocol.ValidHistoryIdentity(sessionID) || strings.HasPrefix(sessionID, "terminal:") {
		return "", errors.New("sessionId is invalid")
	}
	if !utf8.ValidString(prompt) || strings.TrimSpace(prompt) == "" || len(prompt) > protocol.MaxControllerMessageBytes {
		return "", errors.New("invalid resume-send prompt")
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	rc, err := a.connect(ctx)
	if err != nil {
		return "", err
	}
	defer rc.closeLogged()
	thread, err := a.readSendTarget(ctx, rc, sessionID)
	if err != nil {
		return "", err
	}
	status := threadstate.ExtractStatus(thread["status"])
	if status != "notLoaded" && status != "idle" {
		return "", errors.New("resume-send target is neither unloaded nor idle")
	}
	if err := a.resumeUnlessLoaded(ctx, rc, sessionID, status); err != nil {
		return "", err
	}
	thread, err = a.readSendTarget(ctx, rc, sessionID)
	if err != nil {
		return "", err
	}
	if threadstate.ExtractStatus(thread["status"]) != "idle" {
		return "", errors.New("managed thread is not idle; no input sent")
	}
	return a.startTurn(ctx, rc, sessionID, prompt)
}

func (a *AppServerAdapter) resumeUnlessLoaded(ctx context.Context, rc *rpcConn, sessionID, status string) error {
	if status == "idle" {
		// A frozen route continues on this same managed server after its first
		// turn. Loaded membership proves that no writer needs to be acquired.
		loaded, err := rc.getLoadedSet(ctx, a.rpcTimeout)
		if err != nil {
			return err
		}
		if loaded[sessionID] {
			return nil
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	result, err := rc.call(ctx, "thread/resume", map[string]any{"threadId": sessionID, "excludeTurns": true}, a.rpcTimeout)
	if err != nil {
		// In particular, preserve an active-writer rejection. No turn was sent.
		return fmt.Errorf("thread/resume failed: %w", err)
	}
	if _, err := idleSendTarget(result, sessionID); err != nil {
		return fmt.Errorf("thread/resume response rejected: %w", err)
	}
	return nil
}

func (a *AppServerAdapter) readSendTarget(ctx context.Context, rc *rpcConn, sessionID string) (map[string]any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	result, err := rc.call(ctx, "thread/read", map[string]any{"threadId": sessionID, "includeTurns": false}, a.rpcTimeout)
	if err != nil {
		return nil, fmt.Errorf("pre-send thread/read failed: %w", err)
	}
	return exactSendTarget(result, sessionID)
}

func exactSendTarget(result map[string]any, sessionID string) (map[string]any, error) {
	thread, ok := result["thread"].(map[string]any)
	if !ok || thread["id"] != sessionID {
		return nil, errors.New("thread response ID mismatch or missing thread")
	}
	return thread, nil
}

func idleSendTarget(result map[string]any, sessionID string) (map[string]any, error) {
	thread, err := exactSendTarget(result, sessionID)
	if err != nil {
		return nil, err
	}
	if threadstate.ExtractStatus(thread["status"]) != "idle" {
		return nil, errors.New("thread is not idle")
	}
	return thread, nil
}

func (a *AppServerAdapter) startTurn(ctx context.Context, rc *rpcConn, sessionID, prompt string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	result, err := rc.call(ctx, "turn/start", map[string]any{
		"threadId": sessionID,
		"input":    []map[string]any{{"type": "text", "text": prompt}},
	}, a.rpcTimeout)
	if err != nil {
		if errors.Is(err, errInvalidRPCResponse) {
			return "", &codex.UncertainError{Err: errors.New(protocol.InvalidTurnAcknowledgement)}
		}
		return "", &codex.UncertainError{Err: fmt.Errorf("turn/start error (result uncertain): %w", err)}
	}
	turn, _ := result["turn"].(map[string]any)
	turnID, _ := turn["id"].(string)
	if !protocol.ValidTurnID(turnID) {
		return "", &codex.UncertainError{Err: errors.New(protocol.InvalidTurnAcknowledgement)}
	}
	return turnID, nil
}
