package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"io"
)

const (
	desktopJSONProjectionLimit = 4 * 1024 * 1024
	desktopJSONScalarLimit     = desktopJSONKeyLimit
	desktopJSONActiveKeyLimit  = 64 * 1024
)

type desktopJSONOutput struct {
	raw     []byte
	limit   int
	failed  bool
	invalid bool
}

func (o *desktopJSONOutput) put(raw []byte) {
	if o.failed {
		return
	}
	if len(raw) > o.limit-len(o.raw) {
		o.failed = true
		return
	}
	// Retained capacity never exceeds the active output budget.
	if len(o.raw)+len(raw) > cap(o.raw) {
		capacity := min(o.limit, max(len(o.raw)+len(raw), max(256, 2*cap(o.raw))))
		grown := make([]byte, len(o.raw), capacity)
		copy(grown, o.raw)
		o.raw = grown
	}
	o.raw = append(o.raw, raw...)
}

func (o *desktopJSONOutput) text(raw string) { o.put([]byte(raw)) }

type desktopJSONTarget struct {
	schema desktopJSONSchema
	output *desktopJSONOutput
}

type desktopJSONProjector struct {
	*desktopJSONLexer
	duplicate  bool
	activeKeys int
}

// Wire framing and the shared body deadline belong to the transport. This
// function consumes the complete bounded body before returning any projection.
func readDesktopSubscriptionEnvelope(ctx context.Context, reader io.Reader) (desktopEnvelope, error) {
	p := &desktopJSONProjector{desktopJSONLexer: newDesktopJSONLexer(ctx, reader)}
	b, err := p.peek()
	if err != nil {
		return desktopEnvelope{}, err
	}
	if b != '{' {
		return desktopEnvelope{}, errDesktopSubscriptionJSON
	}
	output := &desktopJSONOutput{limit: desktopJSONProjectionLimit}
	if err := p.value([]desktopJSONTarget{{desktopJSONEnvelope, output}}, 0); err != nil {
		return desktopEnvelope{}, err
	}
	if _, err := p.peek(); !errors.Is(err, io.EOF) {
		if err != nil {
			return desktopEnvelope{}, err
		}
		return desktopEnvelope{}, errDesktopSubscriptionJSON
	}
	if err := ctx.Err(); err != nil {
		return desktopEnvelope{}, err
	}
	if output.failed {
		return desktopEnvelope{}, errDesktopSubscriptionJSONBounds
	}
	if output.invalid {
		return desktopEnvelope{}, errDesktopSubscriptionJSON
	}
	var message desktopEnvelope
	if err := json.Unmarshal(output.raw, &message); err != nil {
		return desktopEnvelope{}, errDesktopSubscriptionJSON
	}
	if p.duplicate {
		if message.Method == desktopStateChanged {
			return desktopEnvelope{}, errDesktopSubscriptionJSON
		}
		// Malformed lifecycle broadcasts have always been noise. In particular,
		// canonicalizing duplicate keys must not manufacture an unsubscribe.
		return desktopEnvelope{historyControlMalformed: true}, nil
	}
	message.historyControlMalformed = !historyControlFrameShape(output.raw, message)
	return message, nil
}

type desktopJSONScope struct {
	start, limit int
	failed       bool
}

func (p *desktopJSONProjector) value(targets []desktopJSONTarget, depth int) error {
	if err := p.node(depth); err != nil {
		return err
	}
	b, err := p.peek()
	if err != nil {
		return err
	}
	if len(targets) == 1 && targets[0].schema == desktopJSONPatch && b == '{' {
		return p.patch(targets[0].output, depth)
	}
	scopes := make([]desktopJSONScope, len(targets))
	for index, target := range targets {
		o := target.output
		scopes[index] = desktopJSONScope{len(o.raw), o.limit, o.failed}
		if target.schema.soft() {
			o.limit = min(o.limit, len(o.raw)+desktopObservedTurnMetadataLimit)
		}
	}
	switch b {
	case '{':
		err = p.object(targets, depth)
	case '[':
		err = p.array(targets, depth)
	default:
		err = p.scalarValue(targets, b)
	}
	for index, target := range targets {
		o, scope := target.output, scopes[index]
		o.limit = scope.limit
		if err == nil && !scope.failed && o.failed && target.schema.soft() {
			o.raw, o.failed = o.raw[:scope.start], false
			o.text("false")
		}
	}
	return err
}

func (p *desktopJSONProjector) scalarValue(targets []desktopJSONTarget, first byte) error {
	limit := 0
	for _, target := range targets {
		if !target.output.failed && (target.schema == desktopJSONAtom || target.schema == desktopJSONSoftAtom) {
			limit = desktopJSONScalarLimit
		}
	}
	raw, overflow, err := p.scalar(limit)
	if err != nil {
		return err
	}
	for _, target := range targets {
		switch {
		case first == 'n':
			target.output.text("null")
		case target.schema != desktopJSONAtom && target.schema != desktopJSONSoftAtom:
			target.output.text("false")
		case overflow:
			target.output.failed = true
		default:
			target.output.put(raw)
		}
	}
	return nil
}

func (p *desktopJSONProjector) object(targets []desktopJSONTarget, depth int) error {
	for _, target := range targets {
		target.output.text("{")
	}
	first := make([]bool, len(targets))
	for index := range first {
		first[index] = true
	}
	err := p.fields(func(key string) error {
		children := make([]desktopJSONTarget, 0, len(targets))
		for index, target := range targets {
			child := target.schema.field(key)
			if child == desktopJSONInvalid {
				target.output.failed = true
				target.output.invalid = true
				continue
			}
			marker := child == desktopJSONSkip && (target.schema == desktopJSONEnvelope || target.schema == desktopJSONParams)
			if child == desktopJSONSkip && !marker {
				continue
			}
			if !first[index] {
				target.output.text(",")
			}
			first[index] = false
			encoded, err := json.Marshal(key)
			if err != nil {
				return errDesktopSubscriptionJSON
			}
			target.output.put(encoded)
			target.output.text(":")
			if marker {
				target.output.text("false")
			} else {
				children = append(children, desktopJSONTarget{child, target.output})
			}
		}
		return p.value(children, depth+1)
	})
	for _, target := range targets {
		target.output.text("}")
	}
	return err
}

func (p *desktopJSONProjector) fields(consume func(string) error) error {
	if err := p.take('{'); err != nil {
		return err
	}
	seen := make(map[string]bool)
	defer func() { p.activeKeys -= len(seen) }()
	first := true
	for {
		b, err := p.peek()
		if err != nil {
			return err
		}
		if b == '}' {
			return p.take('}')
		}
		if !first {
			if err := p.take(','); err != nil {
				return err
			}
		}
		first = false
		key, err := p.key()
		if err != nil {
			return err
		}
		if seen[key] {
			p.duplicate = true
		} else {
			if p.activeKeys == desktopJSONActiveKeyLimit {
				return errDesktopSubscriptionJSONBounds
			}
			seen[key] = true
			p.activeKeys++
		}
		if err := p.take(':'); err != nil {
			return err
		}
		if err := consume(key); err != nil {
			return err
		}
	}
}

func (p *desktopJSONProjector) array(targets []desktopJSONTarget, depth int) error {
	if err := p.take('['); err != nil {
		return err
	}
	for _, target := range targets {
		target.output.text("[")
	}
	first := true
	for {
		b, err := p.peek()
		if err != nil {
			return err
		}
		if b == ']' {
			if err := p.take(']'); err != nil {
				return err
			}
			break
		}
		if !first {
			if err := p.take(','); err != nil {
				return err
			}
		}
		children := make([]desktopJSONTarget, 0, len(targets))
		for _, target := range targets {
			if child := target.schema.element(); child != desktopJSONSkip {
				if !first {
					target.output.text(",")
				}
				children = append(children, desktopJSONTarget{child, target.output})
			}
		}
		if err := p.value(children, depth+1); err != nil {
			return err
		}
		first = false
	}
	for _, target := range targets {
		target.output.text("]")
	}
	return nil
}
