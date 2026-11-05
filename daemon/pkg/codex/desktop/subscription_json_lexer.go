package desktop

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"unicode/utf8"
)

const (
	desktopJSONReadBuffer = 32 * 1024
	desktopJSONDepthLimit = 128
	desktopJSONNodeLimit  = 2_000_000
	desktopJSONKeyLimit   = 4096
	desktopJSONKeysLimit  = 8 * 1024 * 1024
)

var errDesktopSubscriptionJSON = errors.New("invalid desktop subscription JSON")
var errDesktopSubscriptionJSONBounds = errors.New("desktop subscription JSON exceeds bounds")

// The lexer retains at most a caller-selected scalar prefix. Ignored scalars
// still pass exactly the same syntax, Unicode and cancellation checks.
type desktopJSONLexer struct {
	ctx      context.Context
	r        *bufio.Reader
	nodes    int
	keyBytes int
	read     int
}

func newDesktopJSONLexer(ctx context.Context, r io.Reader) *desktopJSONLexer {
	return &desktopJSONLexer{ctx: ctx, r: bufio.NewReaderSize(r, desktopJSONReadBuffer)}
}

func (l *desktopJSONLexer) readByte() (byte, error) {
	if l.read == 0 {
		if err := l.ctx.Err(); err != nil {
			return 0, err
		}
	}
	b, err := l.r.ReadByte()
	if err != nil {
		return 0, err
	}
	l.read++
	if l.read == desktopJSONReadBuffer {
		l.read = 0
	}
	return b, nil
}

func (l *desktopJSONLexer) peekRaw() (byte, error) {
	if err := l.ctx.Err(); err != nil {
		return 0, err
	}
	b, err := l.r.Peek(1)
	if err != nil {
		return 0, err
	}
	return b[0], nil
}

func desktopJSONWhitespace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\r' || b == '\n'
}

func (l *desktopJSONLexer) peek() (byte, error) {
	for {
		b, err := l.peekRaw()
		if err != nil || !desktopJSONWhitespace(b) {
			return b, err
		}
		if _, err := l.readByte(); err != nil {
			return 0, err
		}
	}
}

func (l *desktopJSONLexer) take(want byte) error {
	b, err := l.peek()
	if err != nil {
		return err
	}
	if b != want {
		return errDesktopSubscriptionJSON
	}
	_, err = l.readByte()
	return err
}

func (l *desktopJSONLexer) node(depth int) error {
	if err := l.ctx.Err(); err != nil {
		return err
	}
	l.nodes++
	if depth > desktopJSONDepthLimit || l.nodes > desktopJSONNodeLimit {
		return errDesktopSubscriptionJSONBounds
	}
	return nil
}

type desktopJSONScalar struct {
	raw      []byte
	limit    int
	overflow bool
}

func (s *desktopJSONScalar) put(b byte) {
	if s.overflow {
		return
	}
	if len(s.raw) == s.limit {
		s.raw, s.overflow = nil, true
		return
	}
	// Bound capacity as well as length; append's geometric growth may otherwise
	// exceed the caller's retained-value budget.
	if len(s.raw) == cap(s.raw) {
		capacity := max(32, 2*cap(s.raw))
		capacity = min(capacity, s.limit)
		grown := make([]byte, len(s.raw), capacity)
		copy(grown, s.raw)
		s.raw = grown
	}
	s.raw = append(s.raw, b)
}

func (l *desktopJSONLexer) scalarByte(s *desktopJSONScalar) (byte, error) {
	b, err := l.readByte()
	if errors.Is(err, io.EOF) {
		return 0, io.ErrUnexpectedEOF
	}
	if err == nil {
		s.put(b)
	}
	return b, err
}

func (l *desktopJSONLexer) scalar(limit int) ([]byte, bool, error) {
	if limit < 0 {
		return nil, false, errDesktopSubscriptionJSONBounds
	}
	b, err := l.peek()
	if err != nil {
		return nil, false, err
	}
	s := desktopJSONScalar{limit: limit}
	switch b {
	case '"':
		err = l.stringScalar(&s)
	case 't':
		err = l.literalScalar(&s, "true")
	case 'f':
		err = l.literalScalar(&s, "false")
	case 'n':
		err = l.literalScalar(&s, "null")
	default:
		err = l.numberScalar(&s)
	}
	if err != nil {
		return nil, s.overflow, err
	}
	if err := l.ctx.Err(); err != nil {
		return nil, s.overflow, err
	}
	return s.raw, s.overflow, nil
}

func (l *desktopJSONLexer) key() (string, error) {
	b, err := l.peek()
	if err != nil {
		return "", err
	}
	if b != '"' {
		return "", errDesktopSubscriptionJSON
	}
	raw, overflow, err := l.scalar(desktopJSONKeyLimit)
	if err != nil {
		return "", err
	}
	if overflow {
		return "", errDesktopSubscriptionJSONBounds
	}
	l.keyBytes += len(raw)
	if l.keyBytes > desktopJSONKeysLimit {
		return "", errDesktopSubscriptionJSONBounds
	}
	var key string
	if err := json.Unmarshal(raw, &key); err != nil {
		return "", errDesktopSubscriptionJSON
	}
	return key, nil
}

func (l *desktopJSONLexer) scalarEnd() error {
	b, err := l.peekRaw()
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err != nil {
		return err
	}
	if desktopJSONWhitespace(b) || b == ',' || b == ']' || b == '}' {
		return nil
	}
	return errDesktopSubscriptionJSON
}

func (l *desktopJSONLexer) literalScalar(s *desktopJSONScalar, literal string) error {
	for index := range len(literal) {
		b, err := l.scalarByte(s)
		if err != nil {
			return err
		}
		if b != literal[index] {
			return errDesktopSubscriptionJSON
		}
	}
	return l.scalarEnd()
}

func desktopJSONDigit(b byte) bool { return b >= '0' && b <= '9' }

func (l *desktopJSONLexer) digits(s *desktopJSONScalar, required bool) error {
	count := 0
	for {
		b, err := l.peekRaw()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		if !desktopJSONDigit(b) {
			break
		}
		if _, err := l.scalarByte(s); err != nil {
			return err
		}
		count++
	}
	if required && count == 0 {
		return errDesktopSubscriptionJSON
	}
	return nil
}

func (l *desktopJSONLexer) numberScalar(s *desktopJSONScalar) error {
	b, err := l.peekRaw()
	if err != nil {
		return err
	}
	if b == '-' {
		if _, err := l.scalarByte(s); err != nil {
			return err
		}
		b, err = l.peekRaw()
		if err != nil {
			return err
		}
	}
	switch {
	case b == '0':
		if _, err := l.scalarByte(s); err != nil {
			return err
		}
	case b >= '1' && b <= '9':
		if err := l.digits(s, true); err != nil {
			return err
		}
	default:
		return errDesktopSubscriptionJSON
	}
	b, err = l.peekRaw()
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	if err == nil && b == '.' {
		if _, err := l.scalarByte(s); err != nil {
			return err
		}
		if err := l.digits(s, true); err != nil {
			return err
		}
		b, err = l.peekRaw()
		if err != nil && !errors.Is(err, io.EOF) {
			return err
		}
	}
	if err == nil && (b == 'e' || b == 'E') {
		if _, err := l.scalarByte(s); err != nil {
			return err
		}
		b, err = l.peekRaw()
		if err != nil {
			return err
		}
		if b == '+' || b == '-' {
			if _, err := l.scalarByte(s); err != nil {
				return err
			}
		}
		if err := l.digits(s, true); err != nil {
			return err
		}
	}
	return l.scalarEnd()
}

func (l *desktopJSONLexer) hexScalar(s *desktopJSONScalar) (uint16, error) {
	var value uint16
	for range 4 {
		b, err := l.scalarByte(s)
		if err != nil {
			return 0, err
		}
		value <<= 4
		switch {
		case b >= '0' && b <= '9':
			value |= uint16(b - '0')
		case b >= 'a' && b <= 'f':
			value |= uint16(b-'a') + 10
		case b >= 'A' && b <= 'F':
			value |= uint16(b-'A') + 10
		default:
			return 0, errDesktopSubscriptionJSON
		}
	}
	return value, nil
}

func (l *desktopJSONLexer) escapeScalar(s *desktopJSONScalar) error {
	b, err := l.scalarByte(s)
	if err != nil {
		return err
	}
	switch b {
	case '"', '\\', '/', 'b', 'f', 'n', 'r', 't':
		return nil
	case 'u':
		value, err := l.hexScalar(s)
		if err != nil {
			return err
		}
		if value >= 0xDC00 && value <= 0xDFFF {
			return errDesktopSubscriptionJSON
		}
		if value < 0xD800 || value > 0xDBFF {
			return nil
		}
		for _, expected := range []byte{'\\', 'u'} {
			b, err := l.scalarByte(s)
			if err != nil {
				return err
			}
			if b != expected {
				return errDesktopSubscriptionJSON
			}
		}
		low, err := l.hexScalar(s)
		if err != nil {
			return err
		}
		if low < 0xDC00 || low > 0xDFFF {
			return errDesktopSubscriptionJSON
		}
		return nil
	default:
		return errDesktopSubscriptionJSON
	}
}

func (l *desktopJSONLexer) stringScalar(s *desktopJSONScalar) error {
	if _, err := l.scalarByte(s); err != nil {
		return err
	}
	for {
		b, err := l.scalarByte(s)
		if err != nil {
			return err
		}
		switch {
		case b == '"':
			return nil
		case b == '\\':
			if err := l.escapeScalar(s); err != nil {
				return err
			}
		case b < 0x20:
			return errDesktopSubscriptionJSON
		case b < utf8.RuneSelf:
			continue
		default:
			var encoded [utf8.UTFMax]byte
			encoded[0] = b
			length := 1
			for !utf8.FullRune(encoded[:length]) {
				if length == len(encoded) {
					return errDesktopSubscriptionJSON
				}
				encoded[length], err = l.scalarByte(s)
				if err != nil {
					return err
				}
				length++
			}
			if value, size := utf8.DecodeRune(encoded[:length]); value == utf8.RuneError && size == 1 {
				return errDesktopSubscriptionJSON
			}
		}
	}
}
