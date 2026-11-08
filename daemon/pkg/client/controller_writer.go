package client

import (
	"fmt"
	"io"
	"time"

	"github.com/gorilla/websocket"
)

const controllerWriteChunkBytes = 4 * 1024

type controllerMessageWriter interface {
	SetWriteDeadline(time.Time) error
	NextWriter(int) (io.WriteCloser, error)
	WriteControl(int, []byte, time.Time) error
}

func writeControllerMessage(conn *websocket.Conn, encoded []byte, idleTimeout, keepaliveInterval time.Duration) error {
	return writeObservedControllerMessage(conn, encoded, idleTimeout, keepaliveInterval, &controllerSendMetrics{})
}

// Keep one logical message intact while bounding each network write. Renewing
// the deadline between fragments lets a progressing large result finish, and
// control pings keep the peer's watchdog alive before the complete JSON arrives.
// The caller serializes data messages; Gorilla permits interleaved control frames.
func writeObservedControllerMessage(conn controllerMessageWriter, encoded []byte, idleTimeout, keepaliveInterval time.Duration, metrics *controllerSendMetrics) error {
	setDeadline := func() error {
		metrics.stage = controllerSetDeadline
		if err := conn.SetWriteDeadline(time.Now().Add(idleTimeout)); err != nil {
			return fmt.Errorf("set controller write deadline: %w", err)
		}
		return nil
	}
	if err := setDeadline(); err != nil {
		return err
	}
	metrics.stage = controllerNextWriter
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
		metrics.stage = controllerChunkWrite
		metrics.chunkCount++
		written, err := writer.Write(chunk)
		metrics.processedBytes += written
		if err != nil {
			return err
		}
		if written != len(chunk) {
			return io.ErrShortWrite
		}
		encoded = encoded[written:]
		if time.Since(lastKeepalive) >= keepaliveInterval {
			metrics.stage = controllerTransferPing
			if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(idleTimeout)); err != nil {
				return fmt.Errorf("controller transfer keepalive failed: %w", err)
			}
			lastKeepalive = time.Now()
		}
	}
	if err := setDeadline(); err != nil {
		return err
	}
	metrics.stage = controllerWriterClose
	return writer.Close()
}
