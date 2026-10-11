// Package terminal observes explicitly selected existing terminal agents and
// provides an opt-in low-level input delivery object. Observation is read-only;
// neither path starts agents, resolves focus, or reads transcript files.
package terminal

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	SessionPrefix           = "terminal:"
	DefaultOperationTimeout = 10 * time.Second
	MaxPanes                = 16
	MaxIdentityBytes        = 4096
	MaxTitleBytes           = 256
	SnapshotLines           = 120
	MaxSnapshotBytes        = 64 << 10
	readSource              = "recent_unwrapped"
	readFormat              = "text"
)

var panePattern = regexp.MustCompile(`^w[0-9]+:p[0-9]+$`)
var sessionPattern = regexp.MustCompile(`^terminal:[A-Za-z0-9_-]{43}$`)

type Observer struct {
	socket           string
	panes            []string
	mu               sync.Mutex
	bindings         map[string]binding
	rpcTimeout       time.Duration
	operationTimeout time.Duration
}

type binding struct {
	Pane      string
	Terminal  string
	Workspace string
	Tab       string
	Provider  string
	Session   *agentSession
}

func NewObserver(socket string, panes []string) *Observer {
	return &Observer{socket: socket, panes: append([]string(nil), panes...), bindings: make(map[string]binding),
		rpcTimeout: DefaultRPCTimeout, operationTimeout: DefaultOperationTimeout}
}

func (o *Observer) validate() error {
	return ValidateSelectors(o.socket, o.panes)
}

// ValidateSelectors checks explicit observation targets without touching the
// filesystem or network. An observer cannot operate on a disabled empty pair.
func ValidateSelectors(socket string, panes []string) error {
	if !filepath.IsAbs(socket) || !validIdentity(socket) || len(panes) == 0 || len(panes) > MaxPanes {
		return errors.New("terminal requires an absolute socket and 1 to 16 explicit panes")
	}
	seen := make(map[string]bool, len(panes))
	for _, pane := range panes {
		if len(pane) > MaxIdentityBytes || !panePattern.MatchString(pane) || seen[pane] {
			return errors.New("terminal pane must be a unique explicit wN:pN identifier")
		}
		seen[pane] = true
	}
	return nil
}

func validIdentity(value string) bool {
	return value != "" && len(value) <= MaxIdentityBytes && utf8.ValidString(value) && strings.TrimSpace(value) == value &&
		!strings.ContainsRune(value, '\ufffd') && strings.IndexFunc(value, unicode.IsControl) < 0
}

func (o *Observer) connect(ctx context.Context) (*rpcClient, error) {
	c, err := dialRPC(ctx, o.socket, o.rpcTimeout)
	if err != nil {
		return nil, err
	}
	var pong struct {
		Type         string  `json:"type"`
		Protocol     *uint64 `json:"protocol"`
		Version      string  `json:"version"`
		Capabilities *struct {
			LiveHandoff                *bool           `json:"live_handoff"`
			DetachedServerDaemon       json.RawMessage `json:"detached_server_daemon"`
			HealthCheck                json.RawMessage `json:"health_check"`
			SurfaceInterest            json.RawMessage `json:"surface_interest"`
			EndpointProtocolGeneration *uint32         `json:"endpoint_protocol_generation"`
		} `json:"capabilities"`
	}
	err = c.call("ping", struct{}{}, &pong)
	if err == nil && (pong.Type != "pong" || pong.Protocol == nil || *pong.Protocol != ProtocolVersion || !validIdentity(pong.Version)) {
		err = errors.New("terminal protocol handshake mismatch")
	}
	if err == nil && pong.Capabilities != nil {
		cap := pong.Capabilities
		if cap.LiveHandoff == nil {
			err = errors.New("terminal capabilities schema is invalid")
		}
		for _, raw := range []json.RawMessage{cap.DetachedServerDaemon, cap.HealthCheck, cap.SurfaceInterest} {
			if !validOptionalBool(raw) {
				err = errors.New("terminal capabilities schema is invalid")
			}
		}
	}
	if err != nil {
		return nil, errors.Join(err, c.close())
	}
	return c, nil
}

func (o *Observer) DiscoverSessions(ctx context.Context) (sessions []protocol.Session, err error) {
	if err = o.validate(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, o.operationTimeout)
	defer cancel()
	c, err := o.connect(ctx)
	if err != nil {
		return nil, err
	}
	defer func() {
		if closeErr := c.close(); closeErr != nil {
			sessions = nil
			err = errors.Join(err, closeErr)
		}
	}()
	sessions = make([]protocol.Session, 0, len(o.panes))
	next := make(map[string]binding, len(o.panes))
	for _, pane := range o.panes {
		info, getErr := c.getAgent(pane)
		if getErr != nil {
			return nil, getErr
		}
		if info == nil {
			continue
		}
		bound := info.binding()
		id, hashErr := o.publicID(bound)
		if hashErr != nil {
			return nil, hashErr
		}
		next[id] = bound
		loaded := false
		sessions = append(sessions, protocol.Session{ID: id, Provider: bound.Provider, Title: info.publicTitle(), Cwd: info.publicCwd(),
			Status: observedStatus(info.Status), Capabilities: []protocol.ActionType{protocol.ActionRead},
			Loaded: &loaded, ObservedAt: time.Now().UTC().Format(time.RFC3339Nano)})
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	o.mu.Lock()
	o.bindings = next
	o.mu.Unlock()
	return sessions, nil
}

func observedStatus(status string) string {
	switch status {
	case "working":
		return "active"
	case "idle", "done":
		return "idle"
	case "blocked":
		return "blocked"
	default:
		return "unknown"
	}
}

func (o *Observer) publicID(b binding) (string, error) {
	encoded, err := json.Marshal([]any{o.socket, b.Pane, b.Terminal, b.Workspace, b.Tab, b.Provider, b.Session})
	if err != nil {
		return "", errors.New("terminal identity encoding failed")
	}
	digest := sha256.Sum256(encoded)
	return SessionPrefix + base64.RawURLEncoding.EncodeToString(digest[:]), nil
}

func sameBinding(a, b binding) bool {
	if a.Pane != b.Pane || a.Terminal != b.Terminal || a.Workspace != b.Workspace || a.Tab != b.Tab || a.Provider != b.Provider {
		return false
	}
	if a.Session == nil || b.Session == nil {
		return a.Session == nil && b.Session == nil
	}
	return *a.Session == *b.Session
}

func (o *Observer) ReadSession(ctx context.Context, id string) (output string, err error) {
	if err = o.validate(); err != nil {
		return "", err
	}
	if !sessionPattern.MatchString(id) {
		return "", errors.New("terminal session identity is invalid")
	}
	o.mu.Lock()
	known, exists := o.bindings[id]
	o.mu.Unlock()
	if !exists {
		return "", errors.New("terminal session was not discovered by this observer")
	}
	ctx, cancel := context.WithTimeout(ctx, o.operationTimeout)
	defer cancel()
	c, err := o.connect(ctx)
	if err != nil {
		return "", err
	}
	defer func() {
		if closeErr := c.close(); closeErr != nil {
			output = ""
			err = errors.Join(err, closeErr)
		}
	}()
	before, err := c.getAgent(known.Pane)
	if err != nil {
		return "", err
	}
	if before == nil || !sameBinding(known, before.binding()) {
		return "", errors.New("terminal session binding changed")
	}
	snapshot, err := c.readPane(known.Pane)
	if err != nil {
		return "", err
	}
	after, err := c.getAgent(known.Pane)
	if err != nil {
		return "", err
	}
	if after == nil || !sameBinding(known, after.binding()) {
		return "", errors.New("terminal session binding changed")
	}
	if snapshot.Pane != known.Pane || snapshot.Workspace != known.Workspace || snapshot.Tab != known.Tab ||
		*snapshot.Revision < *before.Revision || *snapshot.Revision > *after.Revision || *after.Revision < *before.Revision {
		return "", errors.New("terminal snapshot identity or revision mismatch")
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return renderSnapshot(*snapshot.Text, *snapshot.Truncated), nil
}

func renderSnapshot(text string, truncated bool) string {
	if len(text) > MaxSnapshotBytes {
		text = text[len(text)-MaxSnapshotBytes:]
		for len(text) > 0 && !utf8.RuneStart(text[0]) {
			text = text[1:]
		}
		truncated = true
	}
	lines := strings.Split(text, "\n")
	if len(lines) > SnapshotLines {
		text = strings.Join(lines[len(lines)-SnapshotLines:], "\n")
		truncated = true
	}
	notice := "裁剪提示：这是最近终端屏幕的有限快照，不能代表完整对话历史。"
	if truncated {
		notice = "裁剪提示：快照已裁剪，只保留有限的最近终端文本；不是完整对话历史。"
	}
	return fmt.Sprintf("终端快照（非完整对话；最多%d行）\n%s\n\n%s", SnapshotLines, notice, text)
}
