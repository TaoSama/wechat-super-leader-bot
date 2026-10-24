package client

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
	"github.com/gorilla/websocket"
)

const controllerWriteChunkBytes = 4 * 1024

// Keep one logical message intact while bounding each network write. Renewing
// the deadline between fragments lets a progressing large result finish, and
// control pings keep the peer's watchdog alive before the complete JSON arrives.
// The caller serializes data messages; Gorilla permits interleaved control frames.
func writeControllerMessage(conn *websocket.Conn, encoded []byte, idleTimeout, keepaliveInterval time.Duration) error {
	setDeadline := func() error {
		if err := conn.SetWriteDeadline(time.Now().Add(idleTimeout)); err != nil {
			return fmt.Errorf("set controller write deadline: %w", err)
		}
		return nil
	}
	if err := setDeadline(); err != nil {
		return err
	}
	writer, err := conn.NextWriter(websocket.TextMessage)
	if err != nil {
		return err
	}
	lastKeepalive := time.Now()
	for len(encoded) > 0 {
		if err := setDeadline(); err != nil {
			return err
		}
		chunk := encoded[:min(len(encoded), controllerWriteChunkBytes)]
		written, err := writer.Write(chunk)
		if err != nil {
			return err
		}
		if written != len(chunk) {
			return io.ErrShortWrite
		}
		encoded = encoded[written:]
		if time.Since(lastKeepalive) >= keepaliveInterval {
			if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(idleTimeout)); err != nil {
				return fmt.Errorf("controller transfer keepalive failed: %w", err)
			}
			lastKeepalive = time.Now()
		}
	}
	if err := setDeadline(); err != nil {
		return err
	}
	return writer.Close()
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
		cancelConn()
		<-connectionClosed
	}()

	var writeMu sync.Mutex
	sendJSON := func(msg any) error {
		encoded, err := encodeControllerMessage(msg)
		if err != nil {
			return err
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		return writeControllerMessage(wsConn, encoded, controllerWriteTimeout, regularHeartbeatInterval)
	}

	// Connection liveness does not wait for source discovery. A reconnect retains
	// the last successful snapshot with its original observation timestamps.
	catalog := d.discoverSkills()
	hello := protocol.DaemonHelloMessage{
		Type:          "hello",
		Version:       1,
		NodeID:        d.cfg.NodeID,
		Sessions:      d.cachedSessions(),
		Skills:        catalog,
		DeliveryModes: []protocol.DeliveryMode{protocol.DeliveryNextTurn, protocol.DeliverySteer},
	}
	if err := sendJSON(hello); err != nil {
		return fmt.Errorf("failed to send hello: %w", err)
	}
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
