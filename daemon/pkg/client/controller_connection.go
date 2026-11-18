package client

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/gorilla/websocket"
)

const reconnectBackoffResetAfter = 10 * time.Second

type controllerConnectionLifetime struct {
	mu             sync.Mutex
	ctx            context.Context
	startedAt      time.Time
	firstFailureAt time.Time
	endedAt        time.Time
}

func newControllerConnectionLifetime(ctx context.Context) *controllerConnectionLifetime {
	return &controllerConnectionLifetime{ctx: ctx, startedAt: time.Now()}
}

func (l *controllerConnectionLifetime) recordFailure(observedAt time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.endedAt.IsZero() || l.ctx.Err() != nil {
		return
	}
	if l.firstFailureAt.IsZero() || observedAt.Before(l.firstFailureAt) {
		l.firstFailureAt = observedAt
	}
}

func (l *controllerConnectionLifetime) recordSendFailure(_ controllerSendStage, at time.Time) {
	l.recordFailure(at)
}

func (l *controllerConnectionLifetime) recordCommandResultFailure(stage controllerSendStage, at time.Time) {
	// A rejected result payload leaves the socket usable; a failed write does not.
	if stage != controllerEncode {
		l.recordFailure(at)
	}
}

func (l *controllerConnectionLifetime) trackClose(conn *websocket.Conn) {
	handleClose := conn.CloseHandler()
	conn.SetCloseHandler(func(code int, text string) error {
		// The default handler can wait for a close reply before ReadMessage returns.
		l.recordFailure(time.Now())
		return handleClose(code, text)
	})
}

func (l *controllerConnectionLifetime) finish() time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.endedAt.IsZero() {
		l.endedAt = time.Now()
	}
	endedAt := l.endedAt
	if !l.firstFailureAt.IsZero() && l.firstFailureAt.Before(endedAt) {
		endedAt = l.firstFailureAt
	}
	return max(0, endedAt.Sub(l.startedAt))
}

// Run maintains the outbound WebSocket connection to Controller with exponential backoff until ctx is canceled.
func (d *Daemon) Run(ctx context.Context) error {
	defer d.workers.Wait()
	return d.runControllerReconnectLoop(ctx, d.runControllerConnection)
}

func (d *Daemon) runControllerReconnectLoop(ctx context.Context, connect func(context.Context) (time.Duration, error)) error {
	backoff := MinReconnectBackoff

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		connectedFor, err := connect(ctx)
		d.recoverControllerPayload(ctx, err)
		if ctx.Err() != nil {
			return ctx.Err()
		}

		// Dialing, hello failure and cleanup do not establish a stable connection.
		if connectedFor > reconnectBackoffResetAfter {
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
	_, err := d.runControllerConnection(ctx)
	return err
}

// Measure the active connection after hello is written, before deferred cleanup.
func (d *Daemon) runControllerConnection(ctx context.Context) (time.Duration, error) {
	diagnostic := newControllerSendDiagnostic(d.cfg.NodeID)
	// Registered before the connection defers so after_cleanup includes all of them.
	defer diagnostic.setPhase(controllerAfterCleanup)
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+d.cfg.NodeToken)

	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
	}

	wsConn, resp, err := dialer.DialContext(ctx, d.cfg.ControllerURL, headers)
	if err != nil {
		if resp != nil {
			return 0, fmt.Errorf("websocket dial failed (HTTP %d): %w", resp.StatusCode, err)
		}
		return 0, fmt.Errorf("websocket dial failed: %w", err)
	}
	closeConnection := func() {
		if err := wsConn.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			log.Printf("controller connection cleanup failed: %v", err)
		}
	}
	defer closeConnection()
	wsConn.SetReadLimit(controllerInboundFrameLimit)

	connCtx, cancelConn := context.WithCancel(ctx)
	defer cancelConn()
	connectionClosed := make(chan struct{})
	go func() {
		defer close(connectionClosed)
		<-connCtx.Done()
		closeConnection()
	}()
	defer func() {
		diagnostic.setPhase(controllerCleanup)
		cancelConn()
		<-connectionClosed
	}()

	sender := &controllerSender{conn: wsConn, diagnostic: diagnostic}

	// Connection liveness does not wait for source discovery. A reconnect retains
	// the last successful snapshot with its original observation timestamps.
	catalog := d.discoverSkills()
	hello := protocol.DaemonHelloMessage{
		Type:             "hello",
		Version:          1,
		NodeID:           d.cfg.NodeID,
		Sessions:         d.cachedSessions(),
		Skills:           catalog,
		DeliveryModes:    []protocol.DeliveryMode{protocol.DeliveryNextTurn, protocol.DeliverySteer},
		InputAttachments: true,
	}
	if err := sender.send(hello); err != nil {
		return 0, fmt.Errorf("failed to send hello: %w", err)
	}
	lifetime := newControllerConnectionLifetime(connCtx)
	lifetime.trackClose(wsConn)
	sendJSON := func(message any) error { return sender.sendObserved(message, lifetime.recordSendFailure) }
	// Heartbeat loop
	errCh := make(chan error, 2)
	reportFailure := func(err error) {
		lifetime.recordFailure(time.Now())
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
		// Start replay independently of the reader, so ACKs and new commands are
		// handled while a durable result is still crossing a slow connection.
		if err := d.flushResults(sendJSON); err != nil {
			reportFailure(err)
			return
		}
		if err := d.heartbeatLoop(connCtx, updates, skillRefresh, skillCache.snapshot, sendJSON); err != nil {
			reportFailure(err)
		}
	}()

	// Read loop for Controller commands
	readerDone := make(chan struct{})
	historySlots := make(chan struct{}, maxConcurrentHistoryReads)
	var historyWorkers sync.WaitGroup
	defer func() {
		diagnostic.setPhase(controllerCleanup)
		cancelConn()
		closeConnection()
		<-connectionClosed
		<-readerDone
		historyWorkers.Wait()
		d.resetHistory()
		d.resetMedia()
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
				if cmd.Type == "cancel_automation" {
					d.cancelAutomation(data)
					continue
				}
				if cmd.Type == "list_automations" || cmd.Type == "inspect_automation" {
					if err := d.scheduleAutomationRead(connCtx, data, historySlots, &historyWorkers, sendJSON, errCh); err != nil {
						reportFailure(err)
						return
					}
					continue
				}
				if cmd.Type == "cancel_media" {
					d.cancelMedia(data)
					continue
				}
				if cmd.Type == "list_media" || cmd.Type == "read_media" {
					if err := d.scheduleMediaRead(connCtx, data, historySlots, &historyWorkers, sendJSON, errCh); err != nil {
						reportFailure(err)
						return
					}
					continue
				}
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
				if sendErr := sender.sendObserved(res, lifetime.recordCommandResultFailure); sendErr != nil {
					log.Printf("[daemon:%s] failed to send command result for %s: %v", d.cfg.NodeID, c.CommandID, sendErr)
				}
			}(cmd)
		}
	}()

	select {
	case <-ctx.Done():
		return lifetime.finish(), ctx.Err()
	case err := <-errCh:
		return lifetime.finish(), err
	}
}
