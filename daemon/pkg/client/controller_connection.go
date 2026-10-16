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
	wsConn.SetReadLimit(controllerInboundFrameLimit)

	var writeMu sync.Mutex
	sendJSON := func(msg any) error {
		encoded, err := encodeControllerMessage(msg)
		if err != nil {
			return err
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		if err := wsConn.SetWriteDeadline(time.Now().Add(controllerWriteTimeout)); err != nil {
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
