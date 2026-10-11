// Package transcript reads explicitly authorized, public CLI conversation text.
// It never launches an agent or infers authorization from a session path.
package transcript

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/TaoSama/wechat-super-leader-bot/daemon/pkg/protocol"
)

const (
	MaxFileBytes       = 32 << 20
	MaxLineBytes       = 2 << 20
	MaxPageBytes       = 256 << 10
	MaxTextBytes       = 16 << 10
	MaxEntries         = 50000
	MaxDepth           = 8
	MaxGenerations     = 128
	GenerationTTL      = 10 * time.Minute
	MaxConcurrentReads = 4
	MaxCursorMappings  = 256
)

type Config struct{ Roots map[string]string }
type Ref struct{ Source, Agent, Kind, Value string }
type Page struct {
	Items      []protocol.HistoryItem
	NextCursor *string
	Truncated  bool
}
type Reader struct {
	roots  map[string]string
	mu     sync.Mutex
	states map[string]*generationState
	epoch  uint64
	slots  chan struct{}
}
type generationState struct {
	mu         sync.Mutex
	ref        Ref
	path       string
	root, file os.FileInfo
	boundary   int64
	digest     [32]byte
	cursors    map[string]int64
	used       time.Time
	epoch      uint64
}

var safeID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var uuidID = regexp.MustCompile(`^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$`)

func New(config Config) *Reader {
	r := &Reader{roots: map[string]string{}, states: map[string]*generationState{}, slots: make(chan struct{}, MaxConcurrentReads)}
	for agent, root := range config.Roots {
		if (agent == "codex" || agent == "claude" || agent == "grok") && filepath.IsAbs(root) && root != string(filepath.Separator) {
			r.roots[agent] = filepath.Clean(root)
		}
	}
	return r
}

func (r *Reader) Supports(ref Ref) bool {
	if r == nil || r.roots[ref.Agent] == "" || ref.Source != "herdr:"+ref.Agent || ref.Kind != "id" || !safeID.MatchString(ref.Value) {
		return false
	}
	return ref.Agent == "grok" || ((ref.Agent == "codex" || ref.Agent == "claude") && uuidID.MatchString(ref.Value))
}

func failure(message string) error { return errors.New(message) }

func (r *Reader) Reset() {
	if r == nil {
		return
	}
	r.mu.Lock()
	r.states = map[string]*generationState{}
	r.epoch++
	r.mu.Unlock()
}

func (r *Reader) Read(ctx context.Context, ref Ref, generation, cursor string, limit int) (page Page, nextGeneration string, err error) {
	if !r.Supports(ref) {
		return Page{}, "", failure(protocol.HistoryUnavailable)
	}
	if limit < 0 || limit > protocol.MaxHistoryLimit || (cursor != "" && generation == "") {
		return Page{}, "", failure(protocol.HistoryInvalidRequest)
	}
	if limit == 0 {
		limit = protocol.DefaultHistoryLimit
	}
	if err := ctx.Err(); err != nil {
		return Page{}, "", err
	}
	select {
	case r.slots <- struct{}{}:
		defer func() { <-r.slots }()
	default:
		return Page{}, "", failure(protocol.HistoryBusy)
	}
	r.mu.Lock()
	now := time.Now()
	for key, state := range r.states {
		if now.Sub(state.used) >= GenerationTTL {
			delete(r.states, key)
		}
	}
	state := r.states[generation]
	if generation != "" && (state == nil || state.ref != ref) {
		r.mu.Unlock()
		return Page{}, "", failure(protocol.HistoryContextExpired)
	}
	if state == nil {
		if len(r.states) >= MaxGenerations {
			r.mu.Unlock()
			return Page{}, "", failure(protocol.HistoryBusy)
		}
		var bytes [24]byte
		if _, err := rand.Read(bytes[:]); err != nil {
			r.mu.Unlock()
			return Page{}, "", failure(protocol.HistoryFailed)
		}
		generation = base64.RawURLEncoding.EncodeToString(bytes[:])
		state = &generationState{ref: ref, cursors: map[string]int64{}, epoch: r.epoch}
		r.states[generation] = state
	}
	state.used = now
	r.mu.Unlock()
	state.mu.Lock()
	defer state.mu.Unlock()
	upper := int64(-1)
	if cursor != "" {
		var ok bool
		upper, ok = state.cursors[cursor]
		if !ok {
			return Page{}, "", failure(protocol.HistoryContextExpired)
		}
	}
	page, err = r.readFile(ctx, ref, state, upper, limit)
	r.mu.Lock()
	defer r.mu.Unlock()
	if state.epoch != r.epoch || r.states[generation] != state {
		return Page{}, "", failure(protocol.HistoryContextExpired)
	}
	if err != nil {
		if state.file == nil || err.Error() == protocol.HistoryContextExpired {
			delete(r.states, generation)
		}
		return Page{}, "", err
	}
	if page.NextCursor != nil {
		// Backend cursors remain private; the routing layer replaces them with
		// random public tokens. Only previously issued boundaries are accepted.
		boundary, parseErr := strconv.ParseInt(*page.NextCursor, 10, 64)
		if parseErr != nil {
			return Page{}, "", failure(protocol.HistoryFailed)
		}
		if _, exists := state.cursors[*page.NextCursor]; !exists && len(state.cursors) >= MaxCursorMappings {
			return Page{}, "", failure(protocol.HistoryBusy)
		}
		state.cursors[*page.NextCursor] = boundary
	}
	return page, generation, nil
}
