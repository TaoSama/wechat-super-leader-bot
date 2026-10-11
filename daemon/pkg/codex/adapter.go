package codex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/gorilla/websocket"
)

const (
	DefaultDialTimeout    = 3 * time.Second
	DefaultRPCTimeout     = 10 * time.Second
	DefaultListLimit      = 50
	MaxReadLineLength     = 4000
	ProviderCodexApp      = "codex-app"
	MaxWebSocketFrameSize = 8 * 1024 * 1024 // 8MB
	DefaultWriteTimeout   = 5 * time.Second
)

// UncertainError indicates that an operation may have been dispatched or accepted by the server,
// but confirmation was not received due to timeout, disconnect, or lack of turn ID.
type UncertainError struct {
	Err error
}

func (e *UncertainError) Error() string {
	return e.Err.Error()
}

func (e *UncertainError) Unwrap() error {
	return e.Err
}

func IsUncertain(err error) bool {
	var ue *UncertainError
	return errors.As(err, &ue)
}

// SessionAdapter abstracts session discovery, read, and send operations.
type SessionAdapter interface {
	DiscoverSessions(ctx context.Context) ([]protocol.Session, error)
	ReadSession(ctx context.Context, sessionID string) (string, error)
	SendPrompt(ctx context.Context, sessionID string, prompt string) (string, error)
}

// AppServerAdapter connects to an existing Codex App Unix domain WebSocket.
// It never spawns a fallback stdio server or silently resumes unloaded sessions.
type AppServerAdapter struct {
	socketPath  string
	dialTimeout time.Duration
	rpcTimeout  time.Duration
}

func NewAppServerAdapter(socketPath string) *AppServerAdapter {
	return &AppServerAdapter{
		socketPath:  strings.TrimSpace(socketPath),
		dialTimeout: DefaultDialTimeout,
		rpcTimeout:  DefaultRPCTimeout,
	}
}

type rpcConn struct {
	conn      *websocket.Conn
	writeMu   sync.Mutex
	reqID     uint64
	pendingMu sync.Mutex
	pending   map[uint64]chan rpcResponse
	done      chan struct{}
	closeOnce sync.Once
}

type rpcResponse struct {
	result map[string]any
	err    error
}

func (a *AppServerAdapter) connect(ctx context.Context) (*rpcConn, error) {
	if a.socketPath == "" {
		return nil, errors.New("codex app-server socket path is empty")
	}
	fi, err := os.Stat(a.socketPath)
	if err != nil {
		return nil, fmt.Errorf("codex app-server socket unavailable at %s: %w", a.socketPath, err)
	}
	if fi.Mode()&os.ModeSocket == 0 {
		return nil, fmt.Errorf("path %s is not a unix domain socket (mode: %v)", a.socketPath, fi.Mode())
	}

	dialer := websocket.Dialer{
		NetDialContext: func(dialCtx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(dialCtx, "unix", a.socketPath)
		},
		HandshakeTimeout: a.dialTimeout,
	}

	wsConn, resp, err := dialer.DialContext(ctx, "ws://localhost/", nil)
	if err != nil {
		if resp != nil {
			return nil, fmt.Errorf("websocket dial %s failed (HTTP %d): %w", a.socketPath, resp.StatusCode, err)
		}
		return nil, fmt.Errorf("websocket dial %s failed: %w", a.socketPath, err)
	}

	wsConn.SetReadLimit(MaxWebSocketFrameSize)

	rc := &rpcConn{
		conn:    wsConn,
		pending: make(map[uint64]chan rpcResponse),
		done:    make(chan struct{}),
	}
	go rc.readLoop()

	// Perform mandatory initialize -> initialized handshake
	_, err = rc.call(ctx, "initialize", map[string]any{
		"capabilities": map[string]any{"experimentalApi": true},
		"clientInfo": map[string]any{
			"name":    "super-leader-daemon",
			"version": "1.0.0",
		},
	}, a.dialTimeout)
	if err != nil {
		rc.closeLogged()
		return nil, fmt.Errorf("codex initialize handshake failed: %w", err)
	}

	if err := rc.notify("initialized", map[string]any{}); err != nil {
		rc.closeLogged()
		return nil, fmt.Errorf("codex initialized notification failed: %w", err)
	}

	return rc, nil
}

func (rc *rpcConn) readLoop() {
	defer func() {
		rc.closeOnce.Do(func() {
			close(rc.done)
		})
		rc.pendingMu.Lock()
		for id, ch := range rc.pending {
			ch <- rpcResponse{err: errors.New("codex websocket connection closed")}
			delete(rc.pending, id)
		}
		rc.pendingMu.Unlock()
	}()

	for {
		_, data, err := rc.conn.ReadMessage()
		if err != nil {
			return
		}
		var raw map[string]any
		if err := json.Unmarshal(data, &raw); err != nil {
			continue
		}

		// Branch 1: Server-initiated JSON-RPC request or notification ALWAYS has a non-empty "method" field.
		// Check "method" first so server requests with an "id" never collide with client RPC response IDs,
		// and never auto-decline or mutate user approval state on existing sessions.
		if methodVal, hasMethod := raw["method"]; hasMethod && methodVal != nil {
			continue
		}

		// Branch 2: Client RPC response (has "id", no "method").
		idVal, hasID := raw["id"]
		if !hasID || idVal == nil {
			continue
		}
		var id uint64
		switch v := idVal.(type) {
		case float64:
			id = uint64(v)
		case int64:
			id = uint64(v)
		case json.Number:
			parsed, err := strconv.ParseUint(v.String(), 10, 64)
			if err != nil {
				continue
			}
			id = parsed
		default:
			continue
		}

		rc.pendingMu.Lock()
		ch, ok := rc.pending[id]
		if ok {
			delete(rc.pending, id)
		}
		rc.pendingMu.Unlock()
		if !ok || ch == nil {
			continue
		}

		if errObj, hasErr := raw["error"]; hasErr && errObj != nil {
			errBytes, marshalErr := json.Marshal(errObj)
			if marshalErr != nil {
				ch <- rpcResponse{err: fmt.Errorf("codex rpc error: %v", errObj)}
			} else {
				ch <- rpcResponse{err: fmt.Errorf("codex rpc error: %s", string(errBytes))}
			}
			continue
		}

		resMap, _ := raw["result"].(map[string]any)
		if resMap == nil {
			resMap = map[string]any{"value": raw["result"]}
		}
		ch <- rpcResponse{result: resMap}
	}
}

func (rc *rpcConn) notify(method string, params map[string]any) error {
	msg := map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
	}
	rc.writeMu.Lock()
	defer rc.writeMu.Unlock()
	if err := rc.conn.SetWriteDeadline(time.Now().Add(DefaultWriteTimeout)); err != nil {
		return fmt.Errorf("set notification write deadline: %w", err)
	}
	return rc.conn.WriteJSON(msg)
}

func (rc *rpcConn) call(ctx context.Context, method string, params map[string]any, timeout time.Duration) (map[string]any, error) {
	id := atomic.AddUint64(&rc.reqID, 1)
	ch := make(chan rpcResponse, 1)

	rc.pendingMu.Lock()
	select {
	case <-rc.done:
		rc.pendingMu.Unlock()
		return nil, errors.New("codex connection closed")
	default:
		rc.pending[id] = ch
	}
	rc.pendingMu.Unlock()

	req := map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  params,
	}

	rc.writeMu.Lock()
	writeErr := rc.conn.SetWriteDeadline(time.Now().Add(DefaultWriteTimeout))
	if writeErr == nil {
		writeErr = rc.conn.WriteJSON(req)
	}
	rc.writeMu.Unlock()
	if writeErr != nil {
		rc.pendingMu.Lock()
		delete(rc.pending, id)
		rc.pendingMu.Unlock()
		return nil, fmt.Errorf("write rpc %s failed: %w", method, writeErr)
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case resp := <-ch:
		return resp.result, resp.err
	case <-ctx.Done():
		rc.pendingMu.Lock()
		delete(rc.pending, id)
		rc.pendingMu.Unlock()
		return nil, ctx.Err()
	case <-timer.C:
		rc.pendingMu.Lock()
		delete(rc.pending, id)
		rc.pendingMu.Unlock()
		return nil, fmt.Errorf("rpc %s timed out after %s", method, timeout)
	}
}

func (rc *rpcConn) close() error {
	rc.closeOnce.Do(func() {
		close(rc.done)
	})
	return rc.conn.Close()
}

func (rc *rpcConn) closeLogged() {
	if err := rc.close(); err != nil && !errors.Is(err, net.ErrClosed) {
		log.Printf("codex connection cleanup failed: %v", err)
	}
}

// getLoadedSet fetches all loaded thread IDs handling cursor pagination if present.
func (rc *rpcConn) getLoadedSet(ctx context.Context, timeout time.Duration) (map[string]bool, error) {
	loaded := make(map[string]bool)
	cursor := ""
	seenCursors := make(map[string]bool)

	for page := 0; page < maxDiscoveryPages; page++ {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}

		res, err := rc.call(ctx, "thread/loaded/list", params, timeout)
		if err != nil {
			return nil, fmt.Errorf("thread/loaded/list failed: %w", err)
		}

		data, ok := res["data"].([]any)
		if !ok {
			return nil, errors.New("thread/loaded/list returned invalid data")
		}
		for _, item := range data {
			if idStr, ok := item.(string); ok && protocol.ValidHistoryIdentity(idStr) {
				loaded[idStr] = true
			}
		}

		nextCursor, err := pageCursor(res["nextCursor"], seenCursors)
		if err != nil {
			return nil, err
		}
		if nextCursor == "" {
			return loaded, nil
		}
		cursor = nextCursor
	}
	return nil, errors.New("loaded session pagination limit exceeded")
}

// DiscoverSessions queries both thread/loaded/list and thread/list (useStateDbOnly: true).
// Only threads proven loaded in the live Codex App instance receive ["read", "send"] capability;
// unloaded historical threads are downgraded to ["read"] only.
func (a *AppServerAdapter) DiscoverSessions(ctx context.Context) ([]protocol.Session, error) {
	rc, err := a.connect(ctx)
	if err != nil {
		return nil, err
	}
	defer rc.closeLogged()

	loadedSet, err := rc.getLoadedSet(ctx, a.rpcTimeout)
	if err != nil {
		return nil, err
	}

	return a.discoverPages(ctx, rc, loadedSet)
}

// ReadSession reads the conversation history of a thread via thread/read without resuming or mutating it.
func (a *AppServerAdapter) ReadSession(ctx context.Context, sessionID string) (string, error) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return "", errors.New("sessionId is required")
	}

	rc, err := a.connect(ctx)
	if err != nil {
		return "", err
	}
	defer rc.closeLogged()

	loadedSet, err := rc.getLoadedSet(ctx, a.rpcTimeout)
	if err != nil {
		return "", err
	}

	res, err := rc.call(ctx, "thread/read", map[string]any{
		"threadId":     sessionID,
		"includeTurns": true,
	}, a.rpcTimeout)
	if err != nil {
		return "", fmt.Errorf("thread/read failed for %s: %w", sessionID, err)
	}

	threadObj, ok := res["thread"].(map[string]any)
	if !ok {
		return "", fmt.Errorf("thread/read returned no thread object for %s", sessionID)
	}

	return formatThreadReadOutput(sessionID, threadObj, loadedSet[sessionID]), nil
}

// SendPrompt verifies that the target session is currently loaded in the live Codex App instance
// via thread/loaded/list, checks that thread status is "idle" (rejecting active/interrupted/approval/unknown
// to avoid disturbing user foreground work), and starts a turn via turn/start without calling thread/resume.
// Returns the accepted turn summary once the server acknowledges turn/start.
// If turn/start times out or disconnects after write, returns UncertainError.
func (a *AppServerAdapter) SendPrompt(ctx context.Context, sessionID string, prompt string) (string, error) {
	prompt = strings.TrimSpace(prompt)
	if !protocol.ValidHistoryIdentity(sessionID) {
		return "", errors.New("sessionId is invalid")
	}
	if prompt == "" {
		return "", errors.New("prompt must not be empty")
	}

	rc, err := a.connect(ctx)
	if err != nil {
		return "", err
	}
	defer rc.closeLogged()

	// 1. Check loaded set
	loadedSet, err := rc.getLoadedSet(ctx, a.rpcTimeout)
	if err != nil {
		return "", err
	}
	if !loadedSet[sessionID] {
		return "", fmt.Errorf("session %s is not loaded in the live Codex App instance (downgraded to read-only; implicit thread/resume is disabled)", sessionID)
	}

	// 2. Pre-flight check current session state via thread/read
	readRes, err := rc.call(ctx, "thread/read", map[string]any{
		"threadId":     sessionID,
		"includeTurns": false,
	}, a.rpcTimeout)
	if err != nil {
		return "", fmt.Errorf("pre-send thread/read check failed for %s: %w", sessionID, err)
	}
	threadObj, ok := readRes["thread"].(map[string]any)
	if !ok {
		return "", fmt.Errorf("pre-send thread/read returned invalid thread object for %s", sessionID)
	}
	responseID, ok := threadObj["id"].(string)
	if !ok || responseID != sessionID {
		return "", errors.New("pre-send thread/read response thread ID mismatch")
	}
	curStatus := extractStatus(threadObj["status"])
	if curStatus != "idle" {
		return "", fmt.Errorf("session %s is currently %s (not idle); rejecting send to prevent interrupting active user interaction", sessionID, curStatus)
	}

	// 3. Dispatch turn/start
	res, err := rc.call(ctx, "turn/start", map[string]any{
		"threadId": sessionID,
		"input": []map[string]any{
			{
				"type": "text",
				"text": prompt,
			},
		},
	}, a.rpcTimeout)
	if err != nil {
		// Because the RPC write may have reached the server, any network error/timeout here is uncertain
		return "", &UncertainError{Err: fmt.Errorf("turn/start error (result uncertain): %w", err)}
	}

	turnObj, _ := res["turn"].(map[string]any)
	turnID, _ := turnObj["id"].(string)
	if !protocol.ValidTurnID(turnID) {
		return "", &UncertainError{Err: errors.New(protocol.InvalidTurnAcknowledgement)}
	}

	return fmt.Sprintf("turnId=%s", turnID), nil
}
