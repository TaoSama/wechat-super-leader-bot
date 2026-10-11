package codex

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"time"
	"unicode/utf8"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	desktopInboundFrameLimit  = 32 * 1024 * 1024
	desktopOutboundFrameLimit = 16 * 1024 * 1024
	desktopSkipLimit          = 128
	desktopRequestTimeout     = 2 * time.Second
	desktopOwnerTimeout       = 5 * time.Second
	desktopInitialize         = "initialize"
	desktopDiscoverOwner      = "thread-owner-discovery"
	desktopFollowingChanged   = "thread-stream-following-changed"
	desktopStateChanged       = "thread-stream-state-changed"
)

var errDesktopUnavailable = errors.New("desktop owner unavailable")
var errDesktopFrameTooLarge = errors.New("desktop frame too large")

type desktopEnvelope struct {
	Type              string          `json:"type"`
	RequestID         string          `json:"requestId,omitempty"`
	SourceClientID    string          `json:"sourceClientId,omitempty"`
	TargetClientIDs   []string        `json:"targetClientIds,omitempty"`
	TargetClientID    string          `json:"targetClientId,omitempty"`
	Version           int             `json:"version"`
	Method            string          `json:"method,omitempty"`
	Params            json.RawMessage `json:"params,omitempty"`
	ResultType        string          `json:"resultType,omitempty"`
	HandledByClientID string          `json:"handledByClientId,omitempty"`
	Result            json.RawMessage `json:"result,omitempty"`
	TimeoutMS         int             `json:"timeoutMs,omitempty"`
}
type desktopConn struct {
	net.Conn
	clientID string
}

func (c *desktopConn) write(envelope desktopEnvelope) error {
	data, err := json.Marshal(envelope)
	if err != nil {
		return fmt.Errorf("encode desktop request: %w", err)
	}
	if len(data) > desktopOutboundFrameLimit {
		return errors.New("desktop request too large")
	}
	frame := make([]byte, 4+len(data))
	binary.LittleEndian.PutUint32(frame, uint32(len(data)))
	copy(frame[4:], data)
	for len(frame) > 0 {
		n, err := c.Write(frame)
		if err != nil {
			return fmt.Errorf("write desktop request: %w", err)
		}
		if n == 0 {
			return io.ErrNoProgress
		}
		frame = frame[n:]
	}
	return nil
}

func (c *desktopConn) read() (desktopEnvelope, error) {
	return c.readWithLimit(desktopInboundFrameLimit)
}

func (c *desktopConn) readWithLimit(limit int) (desktopEnvelope, error) {
	var header [4]byte
	var result desktopEnvelope
	if limit <= 0 {
		return result, errors.New("invalid desktop frame limit")
	}
	if _, err := io.ReadFull(c, header[:]); err != nil {
		return result, err
	}
	size := binary.LittleEndian.Uint32(header[:])
	if size == 0 {
		return result, errors.New("invalid desktop frame size")
	}
	if uint64(size) > uint64(limit) {
		return result, errDesktopFrameTooLarge
	}
	data := make([]byte, int(size))
	if _, err := io.ReadFull(c, data); err != nil {
		return result, err
	}
	if !utf8.Valid(data) {
		return result, errors.New("invalid desktop frame encoding")
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return result, errors.New("invalid desktop frame JSON")
	}
	return result, nil
}

func (c *desktopConn) request(ctx context.Context, method string, version int, params any) (desktopEnvelope, error) {
	deadline := time.Now().Add(desktopRequestTimeout)
	if end, ok := ctx.Deadline(); ok && end.Before(deadline) {
		deadline = end
	}
	if err := c.SetDeadline(deadline); err != nil {
		return desktopEnvelope{}, err
	}
	id, err := c.sendRequest(method, version, params)
	if err != nil {
		return desktopEnvelope{}, err
	}
	return c.receiveResponse(id, method)
}

func (c *desktopConn) sendRequest(method string, version int, params any) (string, error) {
	id, err := protocol.NewDispatchID()
	if err != nil {
		return "", err
	}
	payload, err := json.Marshal(params)
	if err != nil {
		return "", err
	}
	if err := c.write(desktopEnvelope{Type: "request", RequestID: id, SourceClientID: c.clientID, Method: method, Version: version, Params: payload, TimeoutMS: int(desktopOwnerTimeout.Milliseconds())}); err != nil {
		return "", err
	}
	return id, nil
}

func (c *desktopConn) receiveResponse(id, method string) (desktopEnvelope, error) {
	for range desktopSkipLimit {
		response, err := c.read()
		if err != nil {
			return response, fmt.Errorf("desktop %s response: %w", method, err)
		}
		if response.Type != "response" || response.RequestID != id {
			continue
		}
		if response.ResultType != "success" {
			return response, errDesktopUnavailable
		}
		if response.Method != method {
			return response, errors.New("desktop response method mismatch")
		}
		return response, nil
	}
	return desktopEnvelope{}, errors.New("desktop response noise limit exceeded")
}

func (c *desktopConn) follow(ownerID, sessionID string, following bool) error {
	params, err := json.Marshal(map[string]any{"conversationId": sessionID, "hostId": "local", "following": following})
	if err != nil {
		return err
	}
	return c.write(desktopEnvelope{Type: "broadcast", Method: desktopFollowingChanged, Version: 1,
		SourceClientID: c.clientID, TargetClientIDs: []string{ownerID}, Params: params})
}

func connectDesktop(ctx context.Context, socketPath string) (*desktopConn, func(), error) {
	return connectDesktopClient(ctx, socketPath, "super-leader-readonly-observer")
}

func connectDesktopClient(ctx context.Context, socketPath, clientType string) (*desktopConn, func(), error) {
	connection, err := (&net.Dialer{Timeout: desktopRequestTimeout}).DialContext(ctx, "unix", socketPath)
	if err != nil {
		return nil, nil, fmt.Errorf("connect desktop observer: %w", err)
	}
	closeConnection := func() {
		if err := connection.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			log.Printf("desktop observer connection cleanup failed: %v", err)
		}
	}
	canceled := make(chan struct{})
	stop := context.AfterFunc(ctx, func() { defer close(canceled); closeConnection() })
	cleanup := func() {
		if !stop() {
			<-canceled
		}
		closeConnection()
	}
	c := &desktopConn{Conn: connection, clientID: "initializing-client"}
	initialized, err := c.request(ctx, desktopInitialize, 0, map[string]string{"clientType": clientType})
	if err != nil {
		cleanup()
		return nil, nil, err
	}
	var identity struct {
		ClientID string `json:"clientId"`
	}
	if err := json.Unmarshal(initialized.Result, &identity); err != nil || !protocol.ValidHistoryIdentity(identity.ClientID) || initialized.HandledByClientID != identity.ClientID {
		cleanup()
		return nil, nil, errors.New("invalid desktop observer identity")
	}
	c.clientID = identity.ClientID
	return c, cleanup, nil
}
