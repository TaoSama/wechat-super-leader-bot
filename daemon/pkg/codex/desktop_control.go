package codex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	desktopControlClient = "super-leader-desktop-controller"
	desktopReadSettings  = "thread-follower-read-model-settings"
	desktopStartTurn     = "thread-follower-start-turn"
	desktopControlSlots  = 2
)

var desktopRequestUUID = regexp.MustCompile(`^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$`)

type DesktopSendRequest struct {
	SessionID           string
	ClientUserMessageID string
	RequestID           string
}

type PreparedDesktopSend interface {
	Identity() protocol.DispatchIdentity
	Dispatch(context.Context, string) (string, error)
	Close()
}

type DesktopController struct {
	socketPath string
	slots      chan struct{}
}

func NewDesktopController(socketPath string) *DesktopController {
	return &DesktopController{socketPath: socketPath, slots: make(chan struct{}, desktopControlSlots)}
}

// CheckSendReadiness only reads the existing owner's settings and full snapshot.
// It allocates no dispatch claim and can never start or resume a turn.
func (d *DesktopController) CheckSendReadiness(ctx context.Context, sessionID string) error {
	if !protocol.ValidHistoryIdentity(sessionID) {
		return errors.New("invalid desktop session identity")
	}
	p, err := d.prepareConnection(ctx, sessionID)
	if err != nil {
		return err
	}
	defer p.Close()
	_, err = p.preflight(ctx)
	return err
}

type preparedDesktopSend struct {
	ctx          context.Context
	c            *desktopConn
	identity     protocol.DispatchIdentity
	cleanup      func()
	closeOnce    sync.Once
	closed       atomic.Bool
	attempted    atomic.Bool
	snapshotSeen bool
	revision     uint64
}

// PrepareSend only discovers and reads the existing owner. It does not resume
// a thread or create a backend. The caller keeps ctx alive until Close.
func (d *DesktopController) PrepareSend(ctx context.Context, req DesktopSendRequest) (PreparedDesktopSend, error) {
	if !protocol.ValidHistoryIdentity(req.SessionID) || !desktopRequestUUID.MatchString(req.ClientUserMessageID) || !desktopRequestUUID.MatchString(req.RequestID) {
		return nil, errors.New("invalid desktop dispatch identity")
	}
	p, err := d.prepareConnection(ctx, req.SessionID)
	if err != nil {
		return nil, err
	}
	p.identity.ClientUserMessageID, p.identity.RequestID = req.ClientUserMessageID, req.RequestID
	if _, err := p.preflight(ctx); err != nil {
		p.Close()
		return nil, err
	}
	return p, nil
}

func (d *DesktopController) prepareConnection(ctx context.Context, sessionID string) (*preparedDesktopSend, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	select {
	case d.slots <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	release := func() { <-d.slots }
	if err := ctx.Err(); err != nil {
		release()
		return nil, err
	}
	c, cleanup, err := connectDesktopClient(ctx, d.socketPath, desktopControlClient)
	if err != nil {
		release()
		return nil, err
	}
	closeConnection := func() { cleanup(); release() }
	response, err := c.request(ctx, desktopDiscoverOwner, 1, map[string]string{"hostId": "local", "conversationId": sessionID})
	if err != nil {
		closeConnection()
		return nil, err
	}
	if !protocol.ValidHistoryIdentity(response.HandledByClientID) || response.HandledByClientID == c.clientID {
		closeConnection()
		return nil, errors.New("invalid desktop owner identity")
	}
	return &preparedDesktopSend{ctx: ctx, c: c, cleanup: closeConnection, identity: protocol.DispatchIdentity{
		Route: protocol.RouteDesktopOwner, SessionID: sessionID, OwnerID: response.HandledByClientID,
		ConnectionID: c.clientID, Endpoint: d.socketPath,
	}}, nil
}

func (p *preparedDesktopSend) Identity() protocol.DispatchIdentity { return p.identity }

func (p *preparedDesktopSend) Close() {
	p.closeOnce.Do(func() { p.closed.Store(true); p.cleanup() })
}

func (p *preparedDesktopSend) deadline(ctx context.Context) error {
	if err := p.ctx.Err(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if p.closed.Load() {
		return errors.New("desktop preparation closed")
	}
	deadline := time.Now().Add(desktopOwnerTimeout)
	for _, c := range []context.Context{ctx, p.ctx} {
		if end, ok := c.Deadline(); ok && end.Before(deadline) {
			deadline = end
		}
	}
	return p.c.SetDeadline(deadline)
}

func (p *preparedDesktopSend) targeted(ctx context.Context, method string, version int, requestID string, params any) (desktopEnvelope, bool, error) {
	if err := p.deadline(ctx); err != nil {
		return desktopEnvelope{}, false, err
	}
	data, err := json.Marshal(params)
	if err != nil {
		return desktopEnvelope{}, false, err
	}
	if err := p.c.write(desktopEnvelope{Type: "request", RequestID: requestID, SourceClientID: p.c.clientID,
		TargetClientID: p.identity.OwnerID, Method: method, Version: version, Params: data, TimeoutMS: int(desktopOwnerTimeout.Milliseconds())}); err != nil {
		return desktopEnvelope{}, true, err
	}
	response, err := p.c.receiveResponse(requestID, method)
	if err != nil {
		return response, true, err
	}
	if response.HandledByClientID != p.identity.OwnerID {
		return response, true, errors.New("desktop response owner mismatch")
	}
	return response, true, nil
}

func (p *preparedDesktopSend) preflight(ctx context.Context) (*desktopControlState, error) {
	// This is not atomic idle/approval compare-and-start, and snapshots have no
	// subscription request nonce. It cannot eliminate App-user send races.
	id, err := protocol.NewDispatchID()
	if err != nil {
		return nil, err
	}
	response, _, err := p.targeted(ctx, desktopReadSettings, 1, id, map[string]string{"conversationId": p.identity.SessionID})
	if err != nil {
		return nil, err
	}
	var result struct {
		Settings *desktopControlSettings `json:"settings"`
	}
	if err := json.Unmarshal(response.Result, &result); err != nil {
		return nil, err
	}
	if result.Settings == nil || !result.Settings.ordinaryResumed() {
		return nil, errors.New("desktop thread is not an ordinary resumed user thread")
	}
	state, err := p.snapshot(ctx)
	if err != nil {
		return nil, err
	}
	if err := state.readyToSend(); err != nil {
		return nil, err
	}
	return state, nil
}

func (p *preparedDesktopSend) Dispatch(ctx context.Context, prompt string) (string, error) {
	if !p.attempted.CompareAndSwap(false, true) {
		return "", errors.New("desktop dispatch already attempted")
	}
	if !utf8.ValidString(prompt) || strings.TrimSpace(prompt) == "" || len(prompt) > protocol.MaxControllerMessageBytes {
		return "", errors.New("invalid desktop prompt")
	}
	stop := context.AfterFunc(ctx, p.Close)
	defer stop()
	if _, err := p.preflight(ctx); err != nil {
		return "", err
	}
	params := map[string]any{"conversationId": p.identity.SessionID, "turnStart": map[string]any{
		"request": map[string]any{"threadId": p.identity.SessionID, "clientUserMessageId": p.identity.ClientUserMessageID,
			"input": []any{map[string]any{"type": "text", "text": prompt, "text_elements": []any{}}}},
		"context": map[string]any{"inheritThreadSettings": true, "useUserMessageAdmission": false},
	}}
	response, writeAttempted, err := p.targeted(ctx, desktopStartTurn, 2, p.identity.RequestID, params)
	if err != nil {
		if !writeAttempted {
			return "", err
		}
		return "", &UncertainError{Err: fmt.Errorf("desktop turn acknowledgement uncertain: %w", err)}
	}
	var result struct {
		Result struct {
			Turn struct {
				ID string `json:"id"`
			} `json:"turn"`
		} `json:"result"`
	}
	if err := json.Unmarshal(response.Result, &result); err != nil || !protocol.ValidTurnID(result.Result.Turn.ID) {
		return "", &UncertainError{Err: errors.New(protocol.InvalidTurnAcknowledgement)}
	}
	return result.Result.Turn.ID, nil
}
