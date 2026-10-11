package terminal

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"reflect"
	"time"
	"unicode/utf8"
)

const (
	MaxResponseBytes  = 1 << 20
	DefaultRPCTimeout = 3 * time.Second
	ProtocolVersion   = 22
)

type rpcClient struct {
	conn       net.Conn
	reader     *bufio.Reader
	ctx        context.Context
	timeout    time.Duration
	stopCancel func() bool
	cancelDone chan error
}

func dialRPC(ctx context.Context, socket string, timeout time.Duration) (*rpcClient, error) {
	conn, err := (&net.Dialer{Timeout: timeout}).DialContext(ctx, "unix", socket)
	if err != nil {
		return nil, safeIOError(ctx, err)
	}
	c := &rpcClient{conn: conn, reader: bufio.NewReader(conn), ctx: ctx, timeout: timeout, cancelDone: make(chan error, 1)}
	c.stopCancel = context.AfterFunc(ctx, func() { c.cancelDone <- conn.Close() })
	return c, nil
}

func (c *rpcClient) close() error {
	var err error
	if c.stopCancel() {
		err = c.conn.Close()
	} else {
		err = <-c.cancelDone
	}
	if err != nil && !errors.Is(err, net.ErrClosed) {
		return errors.New("terminal connection cleanup failed")
	}
	return nil
}

func safeIOError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var timeout net.Error
	if errors.As(err, &timeout) && timeout.Timeout() {
		return context.DeadlineExceeded
	}
	return errors.New("terminal connection unavailable or invalid frame")
}

func requestID() (string, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", errors.New("terminal request identity unavailable")
	}
	id[6] = (id[6] & 0x0f) | 0x40
	id[8] = (id[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:]), nil
}

func (c *rpcClient) call(method string, params any, result any) error {
	if method != "ping" && method != "agent.get" && method != "pane.read" {
		return errors.New("terminal method is not read-only")
	}
	if err := c.ctx.Err(); err != nil {
		return err
	}
	id, err := requestID()
	if err != nil {
		return err
	}
	request, err := json.Marshal(struct {
		ID     string `json:"id"`
		Method string `json:"method"`
		Params any    `json:"params"`
	}{id, method, params})
	if err != nil {
		return errors.New("terminal request encoding failed")
	}
	deadline := time.Now().Add(c.timeout)
	if ctxDeadline, ok := c.ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
		deadline = ctxDeadline
	}
	if err := c.conn.SetDeadline(deadline); err != nil {
		return safeIOError(c.ctx, err)
	}
	request = append(request, '\n')
	for len(request) > 0 {
		n, err := c.conn.Write(request)
		if err != nil {
			return safeIOError(c.ctx, err)
		}
		if n == 0 {
			return errors.New("terminal request write failed")
		}
		request = request[n:]
	}
	line, err := c.readLine()
	if err != nil {
		return err
	}
	var response struct {
		ID     string          `json:"id"`
		Result json.RawMessage `json:"result"`
		Error  json.RawMessage `json:"error"`
	}
	if err := strictDecode(line, &response); err != nil {
		return err
	}
	if response.ID != id {
		return errors.New("terminal response identity mismatch")
	}
	hasResult, hasError := response.Result != nil, response.Error != nil
	if hasResult == hasError {
		return errors.New("terminal response must contain exactly one result or error")
	}
	if hasError {
		var hostError struct {
			Code    *string `json:"code"`
			Message *string `json:"message"`
		}
		if err := strictDecode(response.Error, &hostError); err != nil {
			return err
		}
		if hostError.Code == nil || hostError.Message == nil {
			return errors.New("terminal error schema is invalid")
		}
		return errors.New("terminal host rejected read-only request")
	}
	return strictDecode(response.Result, result)
}

func (c *rpcClient) readLine() ([]byte, error) {
	line := make([]byte, 0, 4096)
	for {
		fragment, err := c.reader.ReadSlice('\n')
		if len(line)+len(fragment) > MaxResponseBytes {
			return nil, errors.New("terminal response exceeds limit")
		}
		line = append(line, fragment...)
		if err == nil {
			return line[:len(line)-1], nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		return nil, safeIOError(c.ctx, err)
	}
}

// Reject duplicate keys before typed decoding, including nested identity fields.
func strictDecode(data []byte, value any) error {
	if !utf8.Valid(data) {
		return errors.New("terminal response JSON is invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := uniqueJSONValue(decoder, 0); err != nil {
		return errors.New("terminal response JSON is invalid")
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return errors.New("terminal response JSON is invalid")
	}
	decoder = json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return errors.New("terminal response schema is invalid")
	}
	if err := exactKeys(data, reflect.TypeOf(value).Elem()); err != nil {
		return errors.New("terminal response schema is invalid")
	}
	return nil
}

// encoding/json accepts case-insensitive aliases; protocol fields do not.
func exactKeys(data json.RawMessage, typ reflect.Type) error {
	if typ == reflect.TypeOf(json.RawMessage{}) {
		return nil
	}
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		if typ.Kind() == reflect.Pointer {
			return nil
		}
		return errors.New("non-null field is null")
	}
	for typ.Kind() == reflect.Pointer {
		typ = typ.Elem()
	}
	if typ.Kind() == reflect.Map {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(data, &fields); err != nil {
			return err
		}
		for _, raw := range fields {
			if err := exactKeys(raw, typ.Elem()); err != nil {
				return err
			}
		}
		return nil
	}
	if typ.Kind() != reflect.Struct {
		return nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	allowed := map[string]reflect.Type{}
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		name := field.Tag.Get("json")
		if comma := bytes.IndexByte([]byte(name), ','); comma >= 0 {
			name = name[:comma]
		}
		allowed[name] = field.Type
	}
	for key, raw := range fields {
		fieldType, exists := allowed[key]
		if !exists {
			return errors.New("unknown JSON field")
		}
		if err := exactKeys(raw, fieldType); err != nil {
			return err
		}
	}
	return nil
}

func uniqueJSONValue(decoder *json.Decoder, depth int) error {
	const maxJSONDepth = 32
	if depth > maxJSONDepth {
		return errors.New("JSON depth exceeded")
	}
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delim, composite := token.(json.Delim)
	if !composite {
		return nil
	}
	if delim == '{' {
		keys := map[string]bool{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok || keys[key] {
				return errors.New("duplicate JSON key")
			}
			keys[key] = true
			if err := uniqueJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
	} else if delim == '[' {
		for decoder.More() {
			if err := uniqueJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
	} else {
		return errors.New("invalid JSON delimiter")
	}
	_, err = decoder.Token()
	return err
}
