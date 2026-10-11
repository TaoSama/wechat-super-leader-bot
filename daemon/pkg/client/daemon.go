package client

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/codex"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/config"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/terminal"
	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/transcript"
	"github.com/gorilla/websocket"
)

const (
	MinReconnectBackoff = 500 * time.Millisecond
	MaxReconnectBackoff = 15 * time.Second
	CommandExecTimeout  = 30 * time.Second
	MaxDedupeEntries    = 2048
)

type dedupeEntry struct {
	result      protocol.DaemonResultMessage
	fingerprint string
}

// Daemon manages the outbound WebSocket connection to Controller and dispatches commands to the SessionAdapter.
type Daemon struct {
	cfg     *config.Config
	adapter codex.SessionAdapter

	dedupeMu    sync.Mutex
	dedupeCache map[string]dedupeEntry
	dedupeOrder []string

	sessionLocksMu sync.Mutex
	sessionLocks   map[string]*sync.Mutex

	// In-flight command tracking to prevent concurrent execution of the same commandId across sessions
	inFlightMu sync.Mutex
	inFlight   map[string]chan struct{}

	outboxMu           sync.Mutex
	outbox             map[string]protocol.DaemonResultMessage
	journal            commandJournal
	durableJournal     bool
	persistenceMu      sync.Mutex
	pendingPersistence map[string]protocol.DaemonResultMessage
	workers            sync.WaitGroup
	snapshotMu         sync.RWMutex
	sessionSnapshot    []protocol.Session
	sessionCatalog     sessionCatalog
	catalogSnapshot    []protocol.Session
	terminalObserver   sessionCatalog
	terminalHistory    terminalHistoryReader
	terminalSnapshot   []protocol.Session
	terminalDiscovery  chan struct{}
	terminalController *terminal.DeliveryController
	terminalReadiness  map[string]terminalReadinessRecord
	desktopObserver    codex.DesktopWatcher
	desktopController  desktopController
	desktopSnapshot    map[string]protocol.DesktopObservation
	sendReadiness      map[string]desktopReadinessRecord
	desktopGeneration  map[string]uint64
	desktopEpoch       uint64
	desktopHistory     desktopHistoryReader
	historyContexts    *historyContexts
	historyRequests    *historyRequests
}

func NewDaemon(cfg *config.Config, adapter codex.SessionAdapter) *Daemon {
	d := &Daemon{
		cfg:                cfg,
		adapter:            adapter,
		dedupeCache:        make(map[string]dedupeEntry),
		sessionLocks:       make(map[string]*sync.Mutex),
		inFlight:           make(map[string]chan struct{}),
		outbox:             make(map[string]protocol.DaemonResultMessage),
		pendingPersistence: make(map[string]protocol.DaemonResultMessage),
		desktopSnapshot:    make(map[string]protocol.DesktopObservation),
		sendReadiness:      make(map[string]desktopReadinessRecord),
		desktopGeneration:  make(map[string]uint64),
		historyContexts:    newHistoryContexts(),
		historyRequests:    newHistoryRequests(),
		terminalDiscovery:  make(chan struct{}, 1),
		terminalReadiness:  make(map[string]terminalReadinessRecord),
	}
	if cfg.DesktopSocketPath != "" {
		d.desktopObserver = codex.NewDesktopObserver(cfg.DesktopSocketPath)
		d.desktopController = codex.NewDesktopController(cfg.DesktopSocketPath)
		d.desktopHistory = codex.NewDesktopHistoryReader(cfg.DesktopSocketPath)
	}
	if cfg.CodexHome != "" {
		d.sessionCatalog = codex.NewRolloutCatalog(cfg.CodexHome)
	}
	if cfg.TerminalSocketPath != "" && len(cfg.TerminalPanes) != 0 {
		observer := terminal.NewObserver(cfg.TerminalSocketPath, cfg.TerminalPanes)
		d.terminalObserver = observer
		if len(cfg.TerminalHistoryRoots) != 0 {
			if err := config.ValidateTerminalHistory(cfg.TerminalHistoryRoots, cfg.TerminalSocketPath, cfg.TerminalPanes); err != nil {
				log.Printf("terminal history disabled: invalid explicit configuration")
			} else {
				d.terminalHistory = terminal.NewHistoryReader(observer, transcript.New(transcript.Config{Roots: cfg.TerminalHistoryRoots}))
			}
		}
		if cfg.TerminalSendMode == protocol.TerminalNonAtomicMode {
			d.terminalController = terminal.NewDeliveryController(observer)
		}
	}
	return d
}

func (d *Daemon) getSessionLock(sessionID string) *sync.Mutex {
	d.sessionLocksMu.Lock()
	defer d.sessionLocksMu.Unlock()
	mu, exists := d.sessionLocks[sessionID]
	if !exists {
		mu = &sync.Mutex{}
		d.sessionLocks[sessionID] = mu
	}
	return mu
}

func (d *Daemon) checkDedupe(commandID string) (dedupeEntry, bool) {
	d.dedupeMu.Lock()
	defer d.dedupeMu.Unlock()
	entry, ok := d.dedupeCache[commandID]
	return entry, ok
}

func (d *Daemon) recordDedupe(res protocol.DaemonResultMessage, fingerprint string) {
	d.dedupeMu.Lock()
	defer d.dedupeMu.Unlock()
	if _, exists := d.dedupeCache[res.CommandID]; !exists {
		if len(d.dedupeOrder) >= MaxDedupeEntries {
			oldest := d.dedupeOrder[0]
			d.dedupeOrder = d.dedupeOrder[1:]
			delete(d.dedupeCache, oldest)
		}
		d.dedupeOrder = append(d.dedupeOrder, res.CommandID)
	}
	d.dedupeCache[res.CommandID] = dedupeEntry{
		result:      res,
		fingerprint: fingerprint,
	}
}

// Run maintains the outbound WebSocket connection to Controller with exponential backoff until ctx is canceled.
func (d *Daemon) Run(ctx context.Context) error {
	defer d.workers.Wait()
	backoff := MinReconnectBackoff

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		connectedAt := time.Now()
		err := d.runOnce(ctx)
		d.recoverControllerPayload(ctx, err)
		if ctx.Err() != nil {
			return ctx.Err()
		}

		// Reset backoff if we stayed connected for a reasonable time
		if time.Since(connectedAt) > 10*time.Second {
			backoff = MinReconnectBackoff
		}

		log.Printf("[daemon:%s] connection closed (%v), reconnecting in %s", d.cfg.NodeID, err, backoff)

		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}

		backoff *= 2
		if backoff > MaxReconnectBackoff {
			backoff = MaxReconnectBackoff
		}
	}
}

// runOnce establishes one WebSocket session with Controller, sends hello + periodic heartbeats, and handles commands.
func (d *Daemon) runOnce(ctx context.Context) error {
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+d.cfg.NodeToken)

	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
	}

	wsConn, resp, err := dialer.DialContext(ctx, d.cfg.ControllerURL, headers)
	if err != nil {
		if resp != nil {
			return fmt.Errorf("websocket dial failed (HTTP %d): %w", resp.StatusCode, err)
		}
		return fmt.Errorf("websocket dial failed: %w", err)
	}
	closeConnection := func() {
		if err := wsConn.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			log.Printf("controller connection cleanup failed: %v", err)
		}
	}
	defer closeConnection()
	wsConn.SetReadLimit(codex.MaxWebSocketFrameSize)

	var writeMu sync.Mutex
	sendJSON := func(msg any) error {
		encoded, err := encodeControllerMessage(msg)
		if err != nil {
			return err
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		if err := wsConn.SetWriteDeadline(time.Now().Add(codex.DefaultWriteTimeout)); err != nil {
			return fmt.Errorf("set controller write deadline: %w", err)
		}
		return wsConn.WriteMessage(websocket.TextMessage, encoded)
	}

	// Connection liveness does not wait for source discovery. A reconnect retains
	// the last successful snapshot with its original observation timestamps.
	catalog := d.discoverSkills()
	hello := protocol.DaemonHelloMessage{
		Type:     "hello",
		Version:  1,
		NodeID:   d.cfg.NodeID,
		Sessions: d.cachedSessions(),
		Skills:   catalog,
	}
	if err := sendJSON(hello); err != nil {
		return fmt.Errorf("failed to send hello: %w", err)
	}
	if err := d.flushResults(sendJSON); err != nil {
		return err
	}

	connCtx, cancelConn := context.WithCancel(ctx)
	defer cancelConn()

	// Close websocket when connCtx is canceled to unblock ReadMessage
	connectionClosed := make(chan struct{})
	go func() {
		defer close(connectionClosed)
		<-connCtx.Done()
		closeConnection()
	}()

	// Heartbeat loop
	errCh := make(chan error, 2)
	reportFailure := func(err error) {
		select {
		case errCh <- err:
		case <-connCtx.Done():
		}
	}
	skillRefresh := make(chan struct{}, 1)
	skillCache := &skillCatalogCache{catalog: catalog}
	heartbeatDone, skillsDone := make(chan struct{}), make(chan struct{})
	updates := make(chan struct{}, 1)
	waitObservations := d.startSessionWorkers(connCtx, updates)
	go func() {
		defer close(skillsDone)
		refreshSkillCatalog(connCtx, skillRefresh, skillCache, d.discoverSkills)
	}()
	go func() {
		defer close(heartbeatDone)
		if err := d.heartbeatLoop(connCtx, updates, skillRefresh, skillCache.snapshot, sendJSON); err != nil {
			reportFailure(err)
		}
	}()

	// Read loop for Controller commands
	readerDone := make(chan struct{})
	historySlots := make(chan struct{}, maxConcurrentHistoryReads)
	var historyWorkers sync.WaitGroup
	defer func() {
		cancelConn()
		closeConnection()
		<-connectionClosed
		<-readerDone
		historyWorkers.Wait()
		d.resetHistory()
		<-heartbeatDone
		<-skillsDone
		waitObservations()
	}()
	go func() {
		defer close(readerDone)
		for {
			_, data, err := wsConn.ReadMessage()
			if err != nil {
				reportFailure(fmt.Errorf("websocket read error: %w", err))
				return
			}

			var cmd protocol.ControllerCommandMessage
			if err := json.Unmarshal(data, &cmd); err != nil {
				log.Printf("[daemon:%s] ignoring malformed controller message: %v", d.cfg.NodeID, err)
				continue
			}
			if cmd.Type != "command" {
				if cmd.Type == "cancel_history" {
					d.cancelHistory(data)
					continue
				}
				if cmd.Type == "read_history" {
					if err := d.scheduleHistoryRead(connCtx, data, historySlots, &historyWorkers, sendJSON, errCh); err != nil {
						reportFailure(err)
						return
					}
					continue
				}
				if err := d.handleTrackingMessage(connCtx, cmd.Type, data, sendJSON); err != nil {
					reportFailure(err)
					return
				}
				continue
			}

			// Pass daemon root context (ctx), NOT connection context (connCtx),
			// so local session command execution is never killed or corrupted midway if the controller WS drops.
			if !d.reserveResult(cmd.CommandID) {
				res := protocol.DaemonResultMessage{Type: "result", CommandID: cmd.CommandID, Status: protocol.StatusFailed, Error: "Result backlog full; command was not dispatched"}
				if err := sendJSON(res); err != nil {
					reportFailure(err)
					return
				}
				continue
			}
			d.workers.Add(1)
			go func(c protocol.ControllerCommandMessage) {
				defer d.workers.Done()
				res := d.ExecuteCommand(ctx, c)
				d.queueResult(res)
				if sendErr := sendJSON(res); sendErr != nil {
					log.Printf("[daemon:%s] failed to send command result for %s: %v", d.cfg.NodeID, c.CommandID, sendErr)
				}
			}(cmd)
		}
	}()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-errCh:
		return err
	}
}

// ExecuteCommand validates, deduplicates, serializes per-session mutations, and runs the requested action.
func (d *Daemon) executeVolatileCommand(ctx context.Context, cmd protocol.ControllerCommandMessage) protocol.DaemonResultMessage {
	cmdID := strings.TrimSpace(cmd.CommandID)
	fingerprint := cmd.PayloadFingerprint()

	// 1. Check deduplication cache
	if cached, found := d.checkDedupe(cmdID); found && cmdID != "" {
		if cached.fingerprint != fingerprint {
			return protocol.DaemonResultMessage{
				Type:      "result",
				CommandID: cmdID,
				Status:    protocol.StatusFailed,
				Output:    "",
				Error:     fmt.Sprintf("duplicate commandId %q carries conflicting payload parameters", cmdID),
			}
		}
		return cached.result
	}

	// 2. Validate exact node identity, required fields, and command expiry (fails closed)
	if err := cmd.Validate(d.cfg.NodeID, time.Now().UTC()); err != nil {
		res := protocol.DaemonResultMessage{
			Type:      "result",
			CommandID: cmdID,
			Status:    protocol.StatusFailed,
			Output:    "",
			Error:     err.Error(),
		}
		if cmdID != "" {
			d.recordDedupe(res, fingerprint)
		}
		return res
	}

	// 3. Prevent concurrent in-flight execution of the same commandId across sessions
	d.inFlightMu.Lock()
	waitCh, inFlight := d.inFlight[cmdID]
	if inFlight {
		d.inFlightMu.Unlock()
		// Wait for the earlier in-flight execution to finish
		select {
		case <-waitCh:
		case <-ctx.Done():
			return protocol.DaemonResultMessage{
				Type:      "result",
				CommandID: cmdID,
				Status:    protocol.StatusUncertain,
				Output:    "",
				Error:     "context canceled while waiting for in-flight duplicate command",
			}
		}
		if cached, found := d.checkDedupe(cmdID); found {
			if cached.fingerprint != fingerprint {
				return protocol.DaemonResultMessage{
					Type:      "result",
					CommandID: cmdID,
					Status:    protocol.StatusFailed,
					Output:    "",
					Error:     fmt.Sprintf("duplicate commandId %q carries conflicting payload parameters", cmdID),
				}
			}
			return cached.result
		}
	} else {
		notifyCh := make(chan struct{})
		d.inFlight[cmdID] = notifyCh
		d.inFlightMu.Unlock()
		defer func() {
			d.inFlightMu.Lock()
			delete(d.inFlight, cmdID)
			close(notifyCh)
			d.inFlightMu.Unlock()
		}()
	}

	// 4. Serialize operations per sessionId so concurrent requests never race on the same session
	sessionMu := d.getSessionLock(cmd.SessionID)
	sessionMu.Lock()
	defer sessionMu.Unlock()

	// Re-check deduplication after acquiring session lock
	if cached, found := d.checkDedupe(cmdID); found {
		if cached.fingerprint != fingerprint {
			return protocol.DaemonResultMessage{
				Type:      "result",
				CommandID: cmdID,
				Status:    protocol.StatusFailed,
				Output:    "",
				Error:     fmt.Sprintf("duplicate commandId %q carries conflicting payload parameters", cmdID),
			}
		}
		return cached.result
	}

	// Re-check expiry after waiting on session lock
	if cmd.IsExpired() {
		res := protocol.DaemonResultMessage{
			Type:      "result",
			CommandID: cmdID,
			Status:    protocol.StatusFailed,
			Output:    "",
			Error:     "command expired while waiting for session lock",
		}
		d.recordDedupe(res, fingerprint)
		return res
	}

	expiresAt, err := cmd.ParseExpiry()
	if err != nil {
		res := protocol.DaemonResultMessage{Type: "result", CommandID: cmdID, Status: protocol.StatusFailed, Error: err.Error()}
		d.recordDedupe(res, fingerprint)
		return res
	}
	execDeadline := time.Now().Add(CommandExecTimeout)
	if expiresAt.Before(execDeadline) {
		execDeadline = expiresAt
	}
	// WithDeadline also preserves an earlier parent deadline. Native preflight
	// and the mutation write must share the command's remaining lifetime.
	execCtx, cancel := context.WithDeadline(ctx, execDeadline)
	defer cancel()

	var res protocol.DaemonResultMessage
	switch cmd.Action {
	case protocol.ActionRead:
		output, err := d.readSession(execCtx, cmd.SessionID)
		if err != nil {
			if execCtx.Err() != nil {
				// Execution context timed out or was canceled
				res = protocol.DaemonResultMessage{
					Type:      "result",
					CommandID: cmdID,
					Status:    protocol.StatusFailed,
					Output:    "",
					Error:     fmt.Sprintf("read session timed out: %v", err),
				}
			} else {
				res = protocol.DaemonResultMessage{
					Type:      "result",
					CommandID: cmdID,
					Status:    protocol.StatusFailed,
					Output:    "",
					Error:     err.Error(),
				}
			}
		} else {
			res = protocol.DaemonResultMessage{
				Type:          "result",
				CommandID:     cmdID,
				Status:        protocol.StatusCompleted,
				Output:        output,
				OutputPresent: output == "",
			}
		}

	case protocol.ActionSend:
		if isTerminalSession(cmd.SessionID) {
			res = d.sendTerminal(execCtx, cmd)
			break
		}
		prompt, prepareErr := d.prepareSkillPrompt(cmd)
		if prepareErr != nil {
			res = protocol.DaemonResultMessage{Type: "result", CommandID: cmdID, Status: protocol.StatusFailed, Error: prepareErr.Error()}
			break
		}
		if cmd.IsExpired() || execCtx.Err() != nil {
			res = protocol.DaemonResultMessage{Type: "result", CommandID: cmdID, Status: protocol.StatusFailed, Error: "command expired before skill task dispatch"}
			break
		}
		ackOutput, err := d.sendPrompt(execCtx, cmd, prompt)
		if err != nil {
			if codex.IsUncertain(err) || execCtx.Err() != nil {
				// Turn dispatch is uncertain (turn may have started on server)
				res = protocol.DaemonResultMessage{
					Type:      "result",
					CommandID: cmdID,
					Status:    protocol.StatusUncertain,
					Output:    "",
					Error:     err.Error(),
				}
			} else {
				// Definite pre-flight rejection (not loaded, not idle, invalid params)
				res = protocol.DaemonResultMessage{
					Type:      "result",
					CommandID: cmdID,
					Status:    protocol.StatusFailed,
					Output:    "",
					Error:     err.Error(),
				}
			}
		} else if turnID := parseTurnID(ackOutput); turnID != "" {
			// Contract: send RPC returns accepted with turn id, not fabricated completed output
			res = protocol.DaemonResultMessage{
				Type:      "result",
				CommandID: cmdID,
				Status:    protocol.StatusAccepted,
				Output:    ackOutput,
				TurnID:    turnID,
			}
		} else {
			res = protocol.DaemonResultMessage{Type: "result", CommandID: cmdID, Status: protocol.StatusUncertain, Error: protocol.InvalidTurnAcknowledgement}
		}

	default:
		res = protocol.DaemonResultMessage{
			Type:      "result",
			CommandID: cmdID,
			Status:    protocol.StatusFailed,
			Output:    "",
			Error:     fmt.Sprintf("unsupported action %q", cmd.Action),
		}
	}

	d.recordDedupe(res, fingerprint)
	return res
}
